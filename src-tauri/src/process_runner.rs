use std::{
    io::{self, Read},
    process::{Child, Command, Output, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

const MAX_CAPTURE_BYTES: usize = 128 * 1024;
const POLL_INTERVAL: Duration = Duration::from_millis(20);
const EXIT_DRAIN_TIMEOUT: Duration = Duration::from_millis(100);
const KILL_REAP_TIMEOUT: Duration = Duration::from_secs(1);

/// Runs without interactive input and retains at most 128 KiB per output stream.
/// Descendants retaining inherited pipes cannot extend the command's deadline.
pub fn run_bounded(
    mut command: Command,
    timeout: Duration,
    cancelled: &AtomicBool,
) -> Result<Output, String> {
    if cancelled.load(Ordering::Acquire) {
        return Err("外部コマンドの実行を取り消しました。".into());
    }
    if timeout.is_zero() {
        return Err("外部コマンドの実行時間が上限に達しました。".into());
    }
    let started = Instant::now();
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("外部コマンドを開始できませんでした: {error}"))?;
    let result = capture_child(&mut child, started, timeout, cancelled);
    if let Err(error) = &result {
        if let Err(cleanup_error) = terminate_and_reap(child) {
            return Err(format!("{error} {cleanup_error}"));
        }
    }
    result
}

fn capture_child(
    child: &mut Child,
    started: Instant,
    timeout: Duration,
    cancelled: &AtomicBool,
) -> Result<Output, String> {
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    stdout
        .as_ref()
        .ok_or_else(|| "外部コマンドの出力を取得できませんでした。".to_string())?
        .prepare()
        .map_err(|error| format!("外部コマンドの出力を準備できませんでした: {error}"))?;
    stderr
        .as_ref()
        .ok_or_else(|| "外部コマンドのエラー出力を取得できませんでした。".to_string())?
        .prepare()
        .map_err(|error| format!("外部コマンドのエラー出力を準備できませんでした: {error}"))?;
    let mut captured_stdout = Vec::new();
    let mut captured_stderr = Vec::new();
    let mut exited = None;
    loop {
        if cancelled.load(Ordering::Acquire) {
            return Err("外部コマンドの実行を取り消しました。".into());
        }
        if exited.is_none() && started.elapsed() >= timeout {
            return Err("外部コマンドの実行時間が上限に達しました。".into());
        }
        let progress = drain_pipe(&mut stdout, &mut captured_stdout)
            .and_then(|stdout_read| {
                drain_pipe(&mut stderr, &mut captured_stderr)
                    .map(|stderr_read| stdout_read + stderr_read)
            })
            .map_err(|error| format!("外部コマンドの出力を読み取れませんでした: {error}"))?;
        if exited.is_none() {
            if let Some(status) = child
                .try_wait()
                .map_err(|error| format!("外部コマンドの終了を確認できませんでした: {error}"))?
            {
                exited = Some((status, Instant::now()));
            }
        }
        if let Some((status, exited_at)) = exited {
            if (stdout.is_none() && stderr.is_none())
                || exited_at.elapsed() >= EXIT_DRAIN_TIMEOUT
                || started.elapsed() >= timeout
            {
                return Ok(Output {
                    status,
                    stdout: captured_stdout,
                    stderr: captured_stderr,
                });
            }
        }
        if progress == 0 {
            std::thread::sleep(POLL_INTERVAL.min(timeout.saturating_sub(started.elapsed())));
        }
    }
}

fn drain_pipe<T: NonblockingPipe>(
    pipe: &mut Option<T>,
    captured: &mut Vec<u8>,
) -> io::Result<usize> {
    let Some(reader) = pipe.as_mut() else {
        return Ok(0);
    };
    let mut buffer = [0_u8; 8_192];
    let mut drained = 0;
    // Bound each pass so continuous output cannot starve cancellation or the other stream.
    for _ in 0..32 {
        match reader.read_available(&mut buffer) {
            Ok(0) => {
                *pipe = None;
                break;
            }
            Ok(bytes) => {
                drained += bytes;
                let keep = bytes.min(MAX_CAPTURE_BYTES.saturating_sub(captured.len()));
                captured.extend_from_slice(&buffer[..keep]);
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
    Ok(drained)
}

fn terminate_and_reap(mut child: Child) -> Result<(), String> {
    // try_wait also reaps a child that exited just before cancellation.
    if child.try_wait().ok().flatten().is_some() {
        return Ok(());
    }
    let kill_error = child.kill().err();
    let started = Instant::now();
    while started.elapsed() < KILL_REAP_TIMEOUT {
        match child.try_wait() {
            Ok(Some(_)) => return Ok(()),
            Ok(None) => std::thread::sleep(POLL_INTERVAL),
            Err(_) => break,
        }
    }
    // An OS-level uninterruptible child must not block the caller. A dedicated
    // reaper takes responsibility for collecting it if the OS later releases it.
    let reaper = std::thread::Builder::new()
        .name("doon-cli-reaper".into())
        .spawn(move || {
            let _ = child.kill();
            if let Err(error) = child.wait() {
                eprintln!("外部コマンドの終了状態を回収できませんでした: {error}");
            }
        });
    let mut error = match kill_error {
        Some(error) => format!("外部コマンドを停止できませんでした: {error}"),
        None => "外部コマンドの停止確認が時間内に完了しませんでした。".into(),
    };
    if let Err(reaper_error) = reaper {
        error.push_str(&format!(
            " 終了状態を回収する処理を開始できませんでした: {reaper_error}"
        ));
    }
    Err(error)
}

trait NonblockingPipe: Read {
    fn prepare(&self) -> io::Result<()>;
    fn read_available(&mut self, buffer: &mut [u8]) -> io::Result<usize>;
}

#[cfg(unix)]
impl<T: Read + std::os::fd::AsRawFd> NonblockingPipe for T {
    fn prepare(&self) -> io::Result<()> {
        use std::os::raw::c_int;
        unsafe extern "C" {
            fn fcntl(fd: c_int, cmd: c_int, ...) -> c_int;
        }
        const F_GETFL: c_int = 3;
        const F_SETFL: c_int = 4;
        #[cfg(any(target_os = "linux", target_os = "android"))]
        const O_NONBLOCK: c_int = 0x800;
        #[cfg(not(any(target_os = "linux", target_os = "android")))]
        const O_NONBLOCK: c_int = 0x4;
        // SAFETY: this is an owned, open child-pipe descriptor; these fcntl
        // commands take integer flags and do not dereference caller memory.
        let flags = unsafe { fcntl(self.as_raw_fd(), F_GETFL) };
        if flags == -1 || unsafe { fcntl(self.as_raw_fd(), F_SETFL, flags | O_NONBLOCK) } == -1 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    fn read_available(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.read(buffer)
    }
}

#[cfg(windows)]
impl<T: Read + std::os::windows::io::AsRawHandle> NonblockingPipe for T {
    fn prepare(&self) -> io::Result<()> {
        Ok(())
    }

    fn read_available(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        use std::{ffi::c_void, ptr::null_mut};
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn PeekNamedPipe(
                handle: *mut c_void,
                buffer: *mut c_void,
                buffer_size: u32,
                bytes_read: *mut u32,
                total_available: *mut u32,
                bytes_left: *mut u32,
            ) -> i32;
        }
        let mut available = 0_u32;
        // SAFETY: the child pipe handle remains owned by self. Only the valid
        // available-count pointer is written; all unused buffers are null.
        let success = unsafe {
            PeekNamedPipe(
                self.as_raw_handle(),
                null_mut(),
                0,
                null_mut(),
                &mut available,
                null_mut(),
            )
        };
        if success == 0 {
            let error = io::Error::last_os_error();
            return if matches!(error.raw_os_error(), Some(109 | 233)) {
                Ok(0)
            } else {
                Err(error)
            };
        }
        if available == 0 {
            return Err(io::ErrorKind::WouldBlock.into());
        }
        let bytes = buffer.len().min(available as usize);
        self.read(&mut buffer[..bytes])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        process::{Command, Stdio},
        sync::atomic::{AtomicBool, Ordering},
        time::{Duration, Instant},
    };

    fn fixture(mode: &str) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        let fixture_name = concat!(module_path!(), "::fake_cli_fixture")
            .split_once("::")
            .unwrap()
            .1;
        command
            .args(["--exact", fixture_name, "--nocapture"])
            .env("DOON_PROCESS_TEST_MODE", mode);
        command
    }

    #[test]
    fn fake_cli_fixture() {
        let Ok(mode) = std::env::var("DOON_PROCESS_TEST_MODE") else {
            return;
        };
        match mode.as_str() {
            "success" => {
                std::io::stdout().write_all(b"normal-output").unwrap();
                std::io::stderr().write_all(b"normal-error").unwrap();
            }
            "nonzero" => {
                std::io::stderr().write_all(b"rejected").unwrap();
                std::process::exit(23);
            }
            "hang" => std::thread::sleep(Duration::from_secs(30)),
            "large" => {
                let block = [b'x'; 8_192];
                for _ in 0..384 {
                    std::io::stdout().write_all(&block).unwrap();
                    std::io::stderr().write_all(&block).unwrap();
                }
            }
            "stdin" => {
                let mut input = Vec::new();
                std::io::stdin().read_to_end(&mut input).unwrap();
                assert!(input.is_empty());
                std::io::stdout().write_all(b"stdin-closed").unwrap();
            }
            "descendant" => {
                fixture("hold-pipes").stdin(Stdio::null()).spawn().unwrap();
                std::io::stdout().write_all(b"parent-finished").unwrap();
                std::process::exit(0);
            }
            "hold-pipes" => std::thread::sleep(Duration::from_secs(2)),
            _ => panic!("unknown fixture mode"),
        }
    }

    #[test]
    fn captures_both_streams_and_success_status() {
        let result = run_bounded(
            fixture("success"),
            Duration::from_secs(3),
            &AtomicBool::new(false),
        )
        .unwrap();
        assert!(result.status.success());
        assert!(String::from_utf8_lossy(&result.stdout).contains("normal-output"));
        assert!(String::from_utf8_lossy(&result.stderr).contains("normal-error"));
    }

    #[test]
    fn preserves_nonzero_status_and_stderr() {
        let result = run_bounded(
            fixture("nonzero"),
            Duration::from_secs(3),
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(result.status.code(), Some(23));
        assert!(String::from_utf8_lossy(&result.stderr).contains("rejected"));
    }

    #[test]
    fn timeout_terminates_unresponsive_child() {
        let start = Instant::now();
        let result = run_bounded(
            fixture("hang"),
            Duration::from_millis(100),
            &AtomicBool::new(false),
        );
        assert!(result.unwrap_err().contains("時間"));
        assert!(start.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn pre_cancelled_operation_does_not_start_the_command() {
        let result = run_bounded(
            Command::new("doon-voice-deliberately-missing-test-command"),
            Duration::from_secs(1),
            &AtomicBool::new(true),
        );
        assert!(result.unwrap_err().contains("取り消"));
    }

    #[test]
    fn cancellation_stops_a_running_child() {
        let cancelled = AtomicBool::new(false);
        std::thread::scope(|scope| {
            scope.spawn(|| {
                std::thread::sleep(Duration::from_millis(100));
                cancelled.store(true, Ordering::Release);
            });
            let start = Instant::now();
            let result = run_bounded(fixture("hang"), Duration::from_secs(5), &cancelled);
            assert!(result.unwrap_err().contains("取り消"));
            assert!(start.elapsed() < Duration::from_secs(2));
        });
    }

    #[test]
    fn drains_large_output_without_exceeding_capture_limits() {
        let result = run_bounded(
            fixture("large"),
            Duration::from_secs(5),
            &AtomicBool::new(false),
        )
        .unwrap();
        assert!(result.status.success());
        assert_eq!(result.stdout.len(), 128 * 1024);
        assert_eq!(result.stderr.len(), 128 * 1024);
    }

    #[test]
    fn closes_stdin_before_starting_the_child() {
        let mut command = fixture("stdin");
        command.stdin(Stdio::piped());
        let result = run_bounded(command, Duration::from_secs(3), &AtomicBool::new(false)).unwrap();
        assert!(result.status.success());
        assert!(String::from_utf8_lossy(&result.stdout).contains("stdin-closed"));
    }

    #[test]
    fn returns_after_child_exit_when_a_descendant_keeps_pipes_open() {
        let start = Instant::now();
        let result = run_bounded(
            fixture("descendant"),
            Duration::from_secs(4),
            &AtomicBool::new(false),
        )
        .unwrap();
        assert!(result.status.success());
        assert!(String::from_utf8_lossy(&result.stdout).contains("parent-finished"));
        assert!(start.elapsed() < Duration::from_secs(1));
    }

    #[cfg(unix)]
    #[test]
    fn terminated_child_is_reaped() {
        unsafe extern "C" {
            fn waitpid(pid: i32, status: *mut i32, options: i32) -> i32;
        }
        let child = fixture("hang")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id() as i32;
        terminate_and_reap(child).unwrap();
        let mut status = 0;
        // SAFETY: the status pointer is valid; WNOHANG prevents blocking even
        // if the production cleanup unexpectedly failed to terminate the child.
        assert_eq!(unsafe { waitpid(pid, &mut status, 1) }, -1);
        assert_eq!(std::io::Error::last_os_error().raw_os_error(), Some(10));
    }
}

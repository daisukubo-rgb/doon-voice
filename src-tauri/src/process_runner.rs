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
}

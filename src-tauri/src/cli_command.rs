use std::{ffi::OsStr, path::Path, process::Command};

/// npm's Windows .cmd entry points are not native executables. Resolve their
/// Node or native entry without a shell, so all arguments/stdin remain data.
pub(crate) fn cli_command(executable: &Path, path: &OsStr) -> Result<Command, String> {
    #[cfg(windows)]
    let mut command =
        windows_cli_command(executable, &std::env::split_paths(path).collect::<Vec<_>>())?;
    #[cfg(not(windows))]
    let mut command = Command::new(executable);
    command.env("PATH", path);
    Ok(command)
}

pub(crate) fn hide_console(_command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        _command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
}

#[cfg(windows)]
pub(crate) fn login_command(
    executable: &Path,
    path: &OsStr,
    args: &[&str],
) -> Result<Command, String> {
    use std::os::windows::process::CommandExt;
    let mut command = cli_command(executable, path)?;
    command.args(args).creation_flags(0x0000_0010); // CREATE_NEW_CONSOLE
    Ok(command)
}

#[cfg(any(windows, test))]
fn windows_cli_command(executable: &Path, dirs: &[std::path::PathBuf]) -> Result<Command, String> {
    let bases = if executable.components().count() > 1 {
        vec![executable.to_path_buf()]
    } else {
        dirs.iter()
            .filter(|dir| !dir.as_os_str().is_empty())
            .map(|dir| dir.join(executable))
            .collect()
    };
    for base in bases {
        let extension = base.extension().and_then(OsStr::to_str).unwrap_or("");
        let (native, shim) = if extension.eq_ignore_ascii_case("exe") {
            (base.clone(), None)
        } else if extension.eq_ignore_ascii_case("cmd") {
            (base.with_extension("exe"), Some(base.clone()))
        } else {
            let mut native = base.as_os_str().to_os_string();
            native.push(".exe");
            let mut shim = base.as_os_str().to_os_string();
            shim.push(".cmd");
            (native.into(), Some(shim.into()))
        };
        if native.is_file() {
            let native = std::fs::canonicalize(native).map_err(|error| error.to_string())?;
            return Ok(Command::new(native));
        }
        if let Some(shim) = shim.filter(|shim| shim.is_file()) {
            return npm_command(&shim, dirs);
        }
    }
    Err(format!("CLIが見つかりません: {}", executable.display()))
}

#[cfg(any(windows, test))]
fn npm_command(shim: &Path, dirs: &[std::path::PathBuf]) -> Result<Command, String> {
    let unsupported = || format!("このCLIの起動形式には対応していません: {}", shim.display());
    let script = std::fs::read_to_string(shim).map_err(|error| error.to_string())?;
    let uses_node = script
        .lines()
        .any(|line| line.trim().eq_ignore_ascii_case("SET \"_prog=node\""));
    // Accept one standard npm invocation: node + entry, or a native .exe.
    // Additional shell operators, flags and substitutions are never evaluated.
    let mut targets = script.lines().filter_map(|line| {
        let tail = if uses_node {
            line.split_once("\"%_prog%\"")?.1
        } else {
            line
        };
        let tail = tail.trim_start().strip_prefix("\"%dp0%\\")?;
        let (target, rest) = tail.split_once('"')?;
        (rest.trim() == "%*"
            && !target.is_empty()
            && !target.starts_with(['/', '\\'])
            && !target.contains([':', '%', '\r', '\n'])
            && (uses_node || target.to_ascii_lowercase().ends_with(".exe")))
        .then_some(target)
    });
    let target = targets.next().ok_or_else(unsupported)?;
    if targets.next().is_some() {
        return Err(unsupported());
    }
    let parent = shim.parent().ok_or_else(unsupported)?;
    let entry = parent.join(target.replace('\\', "/"));
    if !entry.is_file() {
        return Err(format!("CLIの本体が見つかりません: {}", entry.display()));
    }
    let entry = std::fs::canonicalize(entry).map_err(|error| error.to_string())?;
    if !uses_node {
        return Ok(Command::new(entry));
    }
    let node = std::iter::once(parent.to_path_buf())
        .chain(dirs.iter().cloned())
        .map(|dir| dir.join("node.exe"))
        .find(|path| path.is_file())
        .ok_or_else(|| {
            "Node.jsが見つかりません。Node.jsをインストールして再起動してください。".to_string()
        })?;
    let mut command = Command::new(std::fs::canonicalize(node).map_err(|error| error.to_string())?);
    command.arg(entry);
    Ok(command)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        ffi::OsStr,
        fs,
        path::{Path, PathBuf},
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    struct Fixture(PathBuf);
    static NEXT_FIXTURE_ID: AtomicU64 = AtomicU64::new(0);

    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "doon-cli-{}-{}-{} 日本語 & ! % () ' space",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT_FIXTURE_ID.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn file(&self, relative: &str, contents: &str) -> PathBuf {
            let path = self.0.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, contents).unwrap();
            fs::canonicalize(path).unwrap()
        }

        fn npm(&self) -> PathBuf {
            self.file("codex.cmd", NODE_SHIM);
            self.file(
                "node_modules/@openai/codex/bin/codex.js",
                "#!/usr/bin/env node\n",
            )
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    const NODE_SHIM: &str = "@ECHO off\r\nSET \"_prog=%dp0%\\node.exe\"\r\nSET \"_prog=node\"\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js\" %*\r\n";

    // Standard npm cmd-shim output for Claude Code's no-shebang native binary.
    const NATIVE_SHIM: &str = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe\"   %*\r\n";

    #[test]
    fn node_script_argument_uses_normal_absolute_drive_and_unc_paths() {
        for (input, expected) in [
            (r"\\?\C:\Users\日本語 & ! % () '\cli.js", r"C:\Users\日本語 & ! % () '\cli.js"),
            (r"\\?\UNC\server\share\日本語 & ! %\cli.js", r"\\server\share\日本語 & ! %\cli.js"),
        ] {
            assert_eq!(node_script_path_units(&input.encode_utf16().collect::<Vec<_>>()), expected.encode_utf16().collect::<Vec<_>>());
        }
    }

    #[test]
    fn node_script_argument_preserves_long_paths_and_all_utf16_units() {
        let long = format!(r"\\?\C:\{}cli.js", "long folder\\".repeat(40));
        let mut input = long.encode_utf16().collect::<Vec<_>>();
        input.push(0xd800); // Preserve even an unpaired Windows UTF-16 surrogate.
        assert!(input.len() > 260);
        assert_eq!(node_script_path_units(&input), input[4..]);
        let unc = format!(r"\\?\UNC\server\share\{}cli.js", "long folder\\".repeat(40));
        let input = unc.encode_utf16().collect::<Vec<_>>();
        let expected = format!(r"\\server\share\{}cli.js", "long folder\\".repeat(40));
        assert_eq!(node_script_path_units(&input), expected.encode_utf16().collect::<Vec<_>>());
    }

    #[test]
    fn node_script_argument_keeps_other_namespaces_and_ordinary_paths_unchanged() {
        for input in [r"C:\script.js", r"\\server\share\script.js", r"C:relative.js", r"\\?\C:relative.js", r"\\?\Volume{example}\script.js", r"\\.\pipe\example", r"\\?\UNC\"] {
            let units = input.encode_utf16().collect::<Vec<_>>();
            assert_eq!(node_script_path_units(&units), units);
        }
    }

    #[test]
    fn npm_native_shim_resolves_directly_without_node_or_a_shell() {
        let fixture = Fixture::new();
        fixture.file("claude.cmd", NATIVE_SHIM);
        let executable = fixture.file("node_modules/@anthropic-ai/claude-code/bin/claude.exe", "");
        for path in [Path::new("claude"), fixture.0.join("claude.cmd").as_path()] {
            let command = windows_cli_command(path, std::slice::from_ref(&fixture.0)).unwrap();
            assert_eq!(command.get_program(), executable.as_os_str());
            assert_eq!(command.get_args().count(), 0);
        }
        fs::remove_file(executable).unwrap();
        assert!(
            windows_cli_command(Path::new("claude"), std::slice::from_ref(&fixture.0)).is_err()
        );
    }

    #[test]
    fn native_shim_rejects_extra_syntax_and_ambiguous_targets() {
        let fixture = Fixture::new();
        fixture.file("node_modules/@anthropic-ai/claude-code/bin/claude.exe", "");
        fixture.file("node_modules/@anthropic-ai/claude-code/bin/claude.js", "");
        for script in [
            NATIVE_SHIM.replace("%*", "%* & echo injected"),
            NATIVE_SHIM.replace("%*", "--other %*"),
            NATIVE_SHIM.replace("%*", "%* > output.txt"),
            NATIVE_SHIM.replace("claude.exe", "claude.js"),
            format!("{NATIVE_SHIM}\"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe\" %*\r\n"),
        ] {
            fixture.file("claude.cmd", &script);
            assert!(windows_cli_command(Path::new("claude"), std::slice::from_ref(&fixture.0)).is_err());
        }
    }

    #[test]
    fn npm_node_shim_resolves_to_node_and_entry_without_a_shell() {
        let fixture = Fixture::new();
        let entry = fixture.npm();
        let node = fixture.file("node.exe", "");
        let command =
            windows_cli_command(Path::new("codex"), std::slice::from_ref(&fixture.0)).unwrap();
        assert_eq!(command.get_program(), node.as_os_str());
        let args = command.get_args().collect::<Vec<_>>();
        assert_eq!(args.len(), 1);
        assert_eq!(fs::canonicalize(args[0]).unwrap(), entry);
        assert!(!args[0].to_string_lossy().starts_with(r"\\?\"));
    }

    #[test]
    fn native_exe_takes_precedence_over_a_shim_and_stays_direct() {
        let fixture = Fixture::new();
        fixture.npm();
        let native = fixture.file("codex.exe", "");
        for path in [Path::new("codex"), native.as_path()] {
            let command = windows_cli_command(path, std::slice::from_ref(&fixture.0)).unwrap();
            assert_eq!(command.get_program(), native.as_os_str());
            assert_eq!(command.get_args().count(), 0);
        }
    }

    #[test]
    fn npm_node_can_be_found_elsewhere_on_the_same_search_path() {
        let fixture = Fixture::new();
        let entry = fixture.npm();
        let node = fixture.file("node-install/node.exe", "");
        let command = windows_cli_command(
            &fixture.0.join("codex.cmd"),
            &[fixture.0.clone(), fixture.0.join("node-install")],
        )
        .unwrap();
        assert_eq!(command.get_program(), node.as_os_str());
        let args = command.get_args().collect::<Vec<_>>();
        assert_eq!(args.len(), 1);
        assert_eq!(fs::canonicalize(args[0]).unwrap(), entry);
        assert!(!args[0].to_string_lossy().starts_with(r"\\?\"));
    }

    #[test]
    fn missing_node_or_entry_does_not_claim_a_usable_cli() {
        let fixture = Fixture::new();
        let entry = fixture.npm();
        assert!(windows_cli_command(Path::new("codex"), std::slice::from_ref(&fixture.0)).is_err());
        fixture.file("node.exe", "");
        fs::remove_file(entry).unwrap();
        assert!(windows_cli_command(Path::new("codex"), std::slice::from_ref(&fixture.0)).is_err());
    }

    #[test]
    fn unsupported_or_shell_extended_batch_is_never_executed() {
        let fixture = Fixture::new();
        fixture.npm();
        fixture.file("node.exe", "");
        for script in [
            "@echo off\r\necho arbitrary batch\r\n".to_string(),
            NODE_SHIM.replace(" %*", " %* & echo injected"),
            NODE_SHIM.replace("%_prog%\"  ", "%_prog%\" --eval "),
            NODE_SHIM.replace("_prog=node", "_prog=powershell"),
        ] {
            fixture.file("codex.cmd", &script);
            assert!(
                windows_cli_command(Path::new("codex"), std::slice::from_ref(&fixture.0)).is_err()
            );
        }
    }

    #[test]
    fn shell_metacharacters_remain_literal_arguments() {
        let fixture = Fixture::new();
        fixture.npm();
        let node = fixture.file("node.exe", "");
        let input = "日本語 & whoami | echo \"quoted\" %PATH% !NAME! $(touch injected)\nline two";
        let mut command =
            windows_cli_command(Path::new("codex"), std::slice::from_ref(&fixture.0)).unwrap();
        command.arg(input);
        assert_eq!(command.get_program(), node.as_os_str());
        assert_eq!(command.get_args().last(), Some(OsStr::new(input)));
        assert_eq!(command.get_args().count(), 2);
    }

    #[cfg(windows)]
    fn verify_windows_npm_mock(prefix: &str) {
        use std::io::Write;
        use std::process::Stdio;
        let fixture = Fixture::new();
        let install_dir = fixture.0.join(prefix);
        fixture.file(&format!("{prefix}/codex.cmd"), NODE_SHIM);
        fixture.file(&format!("{prefix}/node_modules/@openai/codex/bin/codex.js"), r#"
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => process.stdout.write(JSON.stringify({args: process.argv.slice(2), input})));
"#);
        let inherited = std::env::var_os("PATH").unwrap();
        let mut paths = vec![install_dir];
        paths.extend(std::env::split_paths(&inherited));
        let path = std::env::join_paths(paths).unwrap();
        let input = "日本語 & echo injected | whoami %PATH% !VAR! \"quote\"\nnext line";
        let mut command = cli_command(Path::new("codex"), &path).unwrap();
        command.args(["login", "status", input]);
        hide_console(&mut command);
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(input.as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(value["args"], serde_json::json!(["login", "status", input]));
        assert_eq!(value["input"], input);
    }

    #[cfg(windows)]
    #[test]
    fn windows_npm_mock_preserves_arguments_and_stdin_without_shell_expansion() {
        verify_windows_npm_mock("npm");
    }

    #[cfg(windows)]
    #[test]
    fn windows_npm_mock_runs_a_script_beyond_the_legacy_path_length_limit() {
        verify_windows_npm_mock(&format!("{0}/{0}/{0}", "long-path-segment".repeat(8)));
    }
}

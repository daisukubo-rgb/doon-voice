#[cfg(test)]
mod tests {
    use super::*;
    use std::{ffi::OsStr, fs, path::{Path, PathBuf}, time::{SystemTime, UNIX_EPOCH}};

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "doon-cli-{}-{} 日本語 & ! % () ' space",
                std::process::id(),
                SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
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
            self.file("node_modules/@openai/codex/bin/codex.js", "#!/usr/bin/env node\n")
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) { fs::remove_dir_all(&self.0).unwrap(); }
    }

    const NODE_SHIM: &str = "@ECHO off\r\nSET \"_prog=%dp0%\\node.exe\"\r\nSET \"_prog=node\"\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js\" %*\r\n";

    #[test]
    fn npm_node_shim_resolves_to_node_and_entry_without_a_shell() {
        let fixture = Fixture::new();
        let entry = fixture.npm();
        let node = fixture.file("node.exe", "");
        let command = windows_cli_command(Path::new("codex"), &[fixture.0.clone()]).unwrap();
        assert_eq!(command.get_program(), node.as_os_str());
        assert_eq!(command.get_args().collect::<Vec<_>>(), [entry.as_os_str()]);
    }

    #[test]
    fn native_exe_takes_precedence_over_a_shim_and_stays_direct() {
        let fixture = Fixture::new();
        fixture.npm();
        let native = fixture.file("codex.exe", "");
        for path in [Path::new("codex"), native.as_path()] {
            let command = windows_cli_command(path, &[fixture.0.clone()]).unwrap();
            assert_eq!(command.get_program(), native.as_os_str());
            assert_eq!(command.get_args().count(), 0);
        }
    }

    #[test]
    fn npm_node_can_be_found_elsewhere_on_the_same_search_path() {
        let fixture = Fixture::new();
        let entry = fixture.npm();
        let node = fixture.file("node-install/node.exe", "");
        let command = windows_cli_command(&fixture.0.join("codex.cmd"), &[
            fixture.0.clone(), fixture.0.join("node-install")
        ]).unwrap();
        assert_eq!(command.get_program(), node.as_os_str());
        assert_eq!(command.get_args().collect::<Vec<_>>(), [entry.as_os_str()]);
    }

    #[test]
    fn missing_node_or_entry_does_not_claim_a_usable_cli() {
        let fixture = Fixture::new();
        let entry = fixture.npm();
        assert!(windows_cli_command(Path::new("codex"), &[fixture.0.clone()]).is_err());
        fixture.file("node.exe", "");
        fs::remove_file(entry).unwrap();
        assert!(windows_cli_command(Path::new("codex"), &[fixture.0.clone()]).is_err());
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
            assert!(windows_cli_command(Path::new("codex"), &[fixture.0.clone()]).is_err());
        }
    }

    #[test]
    fn shell_metacharacters_remain_literal_arguments() {
        let fixture = Fixture::new();
        fixture.npm();
        let node = fixture.file("node.exe", "");
        let input = "日本語 & whoami | echo \"quoted\" %PATH% !NAME! $(touch injected)\nline two";
        let mut command = windows_cli_command(Path::new("codex"), &[fixture.0.clone()]).unwrap();
        command.arg(input);
        assert_eq!(command.get_program(), node.as_os_str());
        assert_eq!(command.get_args().last(), Some(OsStr::new(input)));
        assert_eq!(command.get_args().count(), 2);
    }

    #[cfg(windows)]
    #[test]
    fn windows_npm_mock_preserves_arguments_and_stdin_without_shell_expansion() {
        use std::io::Write;
        use std::process::Stdio;
        let fixture = Fixture::new();
        fixture.npm();
        fixture.file("node_modules/@openai/codex/bin/codex.js", r#"
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => process.stdout.write(JSON.stringify({args: process.argv.slice(2), input})));
"#);
        let inherited = std::env::var_os("PATH").unwrap();
        let mut paths = vec![fixture.0.clone()];
        paths.extend(std::env::split_paths(&inherited));
        let path = std::env::join_paths(paths).unwrap();
        let input = "日本語 & echo injected | whoami %PATH% !VAR! \"quote\"\nnext line";
        let mut command = cli_command(Path::new("codex"), &path).unwrap();
        command.args(["login", "status", input]);
        hide_console(&mut command);
        let mut child = command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        child.stdin.take().unwrap().write_all(input.as_bytes()).unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(value["args"], serde_json::json!(["login", "status", input]));
        assert_eq!(value["input"], input);
    }
}

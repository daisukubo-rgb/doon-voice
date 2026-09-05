use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, SystemTime},
};

const RECORDING_DIRECTORY: &str = "recordings";
const RETENTION: Duration = Duration::from_secs(24 * 60 * 60);
static NEXT_FILE: AtomicU64 = AtomicU64::new(0);

/// Owns only the uniquely created recording; every exit path attempts cleanup.
pub struct OwnedAudioFile {
    path: PathBuf,
    active: bool,
}

impl OwnedAudioFile {
    pub fn create(base: &Path, audio: &[u8]) -> Result<Self, String> {
        Self::create_with_writer(base, |file| file.write_all(audio))
    }

    fn create_with_writer(
        base: &Path,
        write_audio: impl FnOnce(&mut File) -> io::Result<()>,
    ) -> Result<Self, String> {
        validate_directory(base)?;
        let directory = base.join(RECORDING_DIRECTORY);
        create_recording_directory(&directory)?;
        let timestamp = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map_err(|error| format!("録音ファイルの時刻を取得できませんでした: {error}"))?
            .as_nanos();
        let mut created = None;
        for _ in 0..16 {
            let path = directory.join(format!(
                "recording-{}-{timestamp}-{}.wav",
                std::process::id(),
                NEXT_FILE.fetch_add(1, Ordering::Relaxed)
            ));
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            match options.open(&path) {
                Ok(file) => {
                    created = Some((path, file));
                    break;
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(format!("録音ファイルを作成できませんでした: {error}")),
            }
        }
        let (path, mut file) =
            created.ok_or_else(|| "重複しない録音ファイルを作成できませんでした。".to_string())?;
        let mut owned = Self { path, active: true };
        let result = write_audio(&mut file).and_then(|()| file.flush());
        // Close the handle before deletion, including on Windows.
        drop(file);
        if let Err(error) = result {
            let cleanup_error = owned
                .cleanup()
                .err()
                .map(|error| format!(" {error}"))
                .unwrap_or_default();
            return Err(format!(
                "録音ファイルを書き込めませんでした: {error}{cleanup_error}"
            ));
        }
        Ok(owned)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn cleanup(&mut self) -> Result<(), String> {
        if !self.active {
            return Ok(());
        }
        // A replaced parent must not redirect cleanup outside the recording directory.
        let parent = self
            .path
            .parent()
            .ok_or_else(|| "録音ファイルの保存先が不正です。".to_string())?;
        match fs::symlink_metadata(parent) {
            Ok(metadata) if metadata.file_type().is_dir() => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                self.active = false;
                return Ok(());
            }
            _ => return Err("録音ファイルの保存先が変更されたため削除できませんでした。".into()),
        }
        match fs::remove_file(&self.path) {
            Ok(()) => {
                self.active = false;
                Ok(())
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                self.active = false;
                Ok(())
            }
            Err(error) => Err(format!("録音ファイルを削除できませんでした: {error}")),
        }
    }
}

impl Drop for OwnedAudioFile {
    fn drop(&mut self) {
        if let Err(error) = self.cleanup() {
            eprintln!("{error}");
        }
    }
}

fn validate_directory(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("録音ファイルの保存先を確認できませんでした: {error}"))?;
    if !metadata.file_type().is_dir() {
        return Err("録音ファイルの保存先が通常のディレクトリではありません。".into());
    }
    Ok(())
}

fn create_recording_directory(path: &Path) -> Result<(), String> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    match builder.create(path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(format!("録音用の保存先を作成できませんでした: {error}")),
    }
    validate_directory(path)
}

pub fn cleanup_stale_recordings(base: &Path) -> Result<usize, String> {
    cleanup_stale_recordings_at(base, SystemTime::now())
}

fn cleanup_stale_recordings_at(base: &Path, now: SystemTime) -> Result<usize, String> {
    match fs::symlink_metadata(base) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0),
        _ => validate_directory(base)?,
    }
    let directory = base.join(RECORDING_DIRECTORY);
    let mut removed = match fs::symlink_metadata(&directory) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => 0,
        _ => {
            validate_directory(&directory)?;
            remove_expired_files(&directory, now, is_recording_name)?
        }
    };
    // Previous releases created <nanosecond timestamp>.wav directly in voice_dir.
    removed += remove_expired_files(base, now, is_legacy_recording_name)?;
    Ok(removed)
}

fn remove_expired_files(
    directory: &Path,
    now: SystemTime,
    owns_name: fn(&str) -> bool,
) -> Result<usize, String> {
    let entries = fs::read_dir(directory)
        .map_err(|error| format!("古い録音ファイルを確認できませんでした: {error}"))?;
    let mut removed = 0;
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("古い録音ファイルを読み取れませんでした: {error}"))?;
        if !entry.file_name().to_str().is_some_and(owns_name) {
            continue;
        }
        let path = entry.path();
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("古い録音ファイルを確認できませんでした: {error}")),
        };
        // Do not traverse subdirectories or follow symbolic links.
        if !metadata.file_type().is_file() {
            continue;
        }
        let modified = metadata
            .modified()
            .map_err(|error| format!("録音ファイルの保存時刻を確認できませんでした: {error}"))?;
        if !now
            .duration_since(modified)
            .is_ok_and(|age| age >= RETENTION)
        {
            continue;
        }
        match fs::remove_file(path) {
            Ok(()) => removed += 1,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("古い録音ファイルを削除できませんでした: {error}")),
        }
    }
    Ok(removed)
}

fn is_recording_name(name: &str) -> bool {
    let Some(stem) = name
        .strip_prefix("recording-")
        .and_then(|name| name.strip_suffix(".wav"))
    else {
        return false;
    };
    let mut parts = stem.split('-');
    (0..3).all(|_| parts.next().is_some_and(is_ascii_digits)) && parts.next().is_none()
}

fn is_legacy_recording_name(name: &str) -> bool {
    name.strip_suffix(".wav").is_some_and(is_ascii_digits)
}

fn is_ascii_digits(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs::{self, FileTimes},
        io::{self, Write},
        path::{Path, PathBuf},
        sync::atomic::{AtomicU64, Ordering},
        time::{Duration, SystemTime},
    };

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "doon-audio-test-{}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    fn set_modified(path: &Path, time: SystemTime) {
        fs::OpenOptions::new()
            .write(true)
            .open(path)
            .unwrap()
            .set_times(FileTimes::new().set_modified(time))
            .unwrap();
    }

    #[test]
    fn owned_audio_files_are_unique_and_removed_on_drop() {
        let root = TestDirectory::new();
        let first = OwnedAudioFile::create(root.path(), b"synthetic wav").unwrap();
        let second = OwnedAudioFile::create(root.path(), b"second wav").unwrap();
        let path = first.path().to_path_buf();
        assert_ne!(path, second.path());
        assert_eq!(fs::read(&path).unwrap(), b"synthetic wav");
        assert_eq!(
            path.parent(),
            Some(root.path().join("recordings").as_path())
        );
        drop(first);
        assert!(!path.exists());
        assert!(second.path().exists());
    }

    #[test]
    fn partially_written_audio_is_removed_when_write_fails() {
        let root = TestDirectory::new();
        let result = OwnedAudioFile::create_with_writer(root.path(), |file| {
            file.write_all(b"partial synthetic audio")?;
            Err(io::Error::other("simulated disk failure"))
        });
        assert!(result.is_err());
        assert_eq!(
            fs::read_dir(root.path().join("recordings"))
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn explicit_cleanup_is_idempotent_and_reports_failure() {
        let root = TestDirectory::new();
        let mut recording = OwnedAudioFile::create(root.path(), b"synthetic").unwrap();
        let path = recording.path().to_path_buf();
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        fs::write(path.join("unrelated"), b"keep").unwrap();
        assert!(recording.cleanup().is_err());
        assert!(path.join("unrelated").exists());
        fs::remove_file(path.join("unrelated")).unwrap();
        fs::remove_dir(&path).unwrap();
        recording.cleanup().unwrap();
        recording.cleanup().unwrap();
    }

    #[test]
    fn stale_cleanup_only_removes_owned_files_after_expiration() {
        let root = TestDirectory::new();
        let directory = root.path().join("recordings");
        fs::create_dir(&directory).unwrap();
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(2_000_000_000);
        let expired = now - Duration::from_secs(24 * 60 * 60);
        let old = directory.join("recording-123-100-0.wav");
        let recent = directory.join("recording-123-101-1.wav");
        let unrelated = directory.join("private.wav");
        let nested = directory.join("nested");
        let legacy_old = root.path().join("123456.wav");
        let legacy_recent = root.path().join("123457.wav");
        let base_unrelated = root.path().join("important.wav");
        fs::create_dir(&nested).unwrap();
        fs::write(nested.join("recording-123-100-0.wav"), b"keep").unwrap();
        for path in [
            &old,
            &recent,
            &unrelated,
            &legacy_old,
            &legacy_recent,
            &base_unrelated,
        ] {
            fs::write(path, b"synthetic").unwrap();
            set_modified(path, expired);
        }
        set_modified(&recent, expired + Duration::from_secs(1));
        set_modified(&legacy_recent, now);
        assert_eq!(cleanup_stale_recordings_at(root.path(), now).unwrap(), 2);
        assert!(!old.exists());
        assert!(!legacy_old.exists());
        for path in [
            &recent,
            &unrelated,
            &legacy_recent,
            &base_unrelated,
            &nested,
        ] {
            assert!(path.exists(), "保存対象: {}", path.display());
        }
    }

    #[cfg(unix)]
    #[test]
    fn recording_directory_symlink_is_never_followed() {
        let root = TestDirectory::new();
        let outside = TestDirectory::new();
        std::os::unix::fs::symlink(outside.path(), root.path().join("recordings")).unwrap();
        assert!(OwnedAudioFile::create(root.path(), b"synthetic").is_err());
        assert!(cleanup_stale_recordings_at(root.path(), SystemTime::now()).is_err());
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn stale_cleanup_does_not_follow_file_symlinks() {
        let root = TestDirectory::new();
        let outside = TestDirectory::new();
        let target = outside.path().join("private.wav");
        fs::write(&target, b"keep").unwrap();
        set_modified(&target, SystemTime::UNIX_EPOCH);
        let directory = root.path().join("recordings");
        fs::create_dir(&directory).unwrap();
        let link = directory.join("recording-123-100-0.wav");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert_eq!(
            cleanup_stale_recordings_at(root.path(), SystemTime::now()).unwrap(),
            0
        );
        assert_eq!(fs::read(&target).unwrap(), b"keep");
        assert!(fs::symlink_metadata(link).unwrap().file_type().is_symlink());
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_rejects_a_parent_replaced_with_a_symlink() {
        let root = TestDirectory::new();
        let outside = TestDirectory::new();
        let mut recording = OwnedAudioFile::create(root.path(), b"synthetic").unwrap();
        let filename = recording.path().file_name().unwrap().to_owned();
        let target = outside.path().join(filename);
        fs::write(&target, b"keep").unwrap();
        let directory = root.path().join("recordings");
        let moved = root.path().join("moved-recordings");
        fs::rename(&directory, &moved).unwrap();
        std::os::unix::fs::symlink(outside.path(), &directory).unwrap();
        assert!(recording.cleanup().is_err());
        assert_eq!(fs::read(&target).unwrap(), b"keep");
        fs::remove_file(&directory).unwrap();
        fs::rename(&moved, &directory).unwrap();
        recording.cleanup().unwrap();
    }
}

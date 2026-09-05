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
                SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_nanos(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn path(&self) -> &Path { &self.0 }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) { fs::remove_dir_all(&self.0).unwrap(); }
    }

    fn set_modified(path: &Path, time: SystemTime) {
        fs::OpenOptions::new().write(true).open(path).unwrap()
            .set_times(FileTimes::new().set_modified(time)).unwrap();
    }

    #[test]
    fn owned_audio_files_are_unique_and_removed_on_drop() {
        let root = TestDirectory::new();
        let first = OwnedAudioFile::create(root.path(), b"synthetic wav").unwrap();
        let second = OwnedAudioFile::create(root.path(), b"second wav").unwrap();
        let path = first.path().to_path_buf();
        assert_ne!(path, second.path());
        assert_eq!(fs::read(&path).unwrap(), b"synthetic wav");
        assert_eq!(path.parent(), Some(root.path().join("recordings").as_path()));
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
        assert_eq!(fs::read_dir(root.path().join("recordings")).unwrap().count(), 0);
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
        for path in [&old, &recent, &unrelated, &legacy_old, &legacy_recent, &base_unrelated] {
            fs::write(path, b"synthetic").unwrap();
            set_modified(path, expired);
        }
        set_modified(&recent, expired + Duration::from_secs(1));
        set_modified(&legacy_recent, now);
        assert_eq!(cleanup_stale_recordings_at(root.path(), now).unwrap(), 2);
        assert!(!old.exists());
        assert!(!legacy_old.exists());
        for path in [&recent, &unrelated, &legacy_recent, &base_unrelated, &nested] {
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
        assert_eq!(cleanup_stale_recordings_at(root.path(), SystemTime::now()).unwrap(), 0);
        assert_eq!(fs::read(&target).unwrap(), b"keep");
        assert!(fs::symlink_metadata(link).unwrap().file_type().is_symlink());
    }
}

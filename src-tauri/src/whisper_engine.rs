#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::PathBuf, time::{SystemTime, UNIX_EPOCH}};

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "doon-whisper-selector-{}-{}",
                std::process::id(),
                SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
            ));
            fs::create_dir_all(&root).unwrap();
            Self(root)
        }

        fn engine_path(&self) -> PathBuf {
            self.0.join("engine/windows-x64/whisper/whisper-avx2.exe")
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) { fs::remove_dir_all(&self.0).unwrap(); }
    }

    #[test]
    fn supported_cpu_selects_the_packaged_avx2_executable() {
        let fixture = Fixture::new();
        let engine = fixture.engine_path();
        fs::create_dir_all(engine.parent().unwrap()).unwrap();
        fs::write(&engine, b"fixture").unwrap();
        assert_eq!(
            select_windows_engine([true; 5], || Ok(fixture.0.clone())).unwrap(),
            Some(engine)
        );
    }

    #[test]
    fn any_missing_cpu_feature_keeps_the_baseline_without_reading_resources() {
        for mask in 0..31 {
            let features = [mask & 1 != 0, mask & 2 != 0, mask & 4 != 0, mask & 8 != 0, mask & 16 != 0];
            assert_eq!(
                select_windows_engine(features, || panic!("baseline must not read resources")).unwrap(),
                None,
                "features={features:?}"
            );
        }
    }

    #[test]
    fn supported_cpu_rejects_a_missing_or_directory_avx2_engine() {
        let fixture = Fixture::new();
        let missing = select_windows_engine([true; 5], || Ok(fixture.0.clone()));
        assert!(missing.unwrap_err().contains("再インストール"));
        fs::create_dir_all(fixture.engine_path()).unwrap();
        let directory = select_windows_engine([true; 5], || Ok(fixture.0.clone()));
        assert!(directory.unwrap_err().contains("再インストール"));
    }

    #[test]
    fn supported_cpu_propagates_resource_resolution_errors() {
        assert_eq!(
            select_windows_engine([true; 5], || Err("resource unavailable".into())).unwrap_err(),
            "resource unavailable"
        );
    }
}

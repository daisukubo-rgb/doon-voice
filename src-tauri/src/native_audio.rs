use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    Device, FromSample, Sample, SampleFormat, SizedSample, Stream, StreamConfig,
};
use std::{
    sync::{
        mpsc::{self, Receiver, Sender},
        Arc, Mutex,
    },
    thread::JoinHandle,
    time::Duration,
};

pub const MAX_WAV_BYTES: usize = 240 * 1024 * 1024;
const WAV_HEADER_BYTES: usize = 44;
const MAX_PCM_SAMPLES: usize = (MAX_WAV_BYTES - WAV_HEADER_BYTES) / 2;
const MAX_RECORDING_SECONDS: usize = 15 * 60;
const WORKER_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug)]
pub struct RecordingResult {
    pub audio: Vec<u8>,
    pub warning: Option<String>,
}

pub struct NativeAudioRecorder {
    commands: Sender<RecorderCommand>,
    worker: Option<JoinHandle<()>>,
    completed: Receiver<()>,
    recording: Arc<Mutex<RecordingBuffer>>,
}

enum RecorderCommand {
    Stop,
}

#[derive(Default)]
struct RecordingBuffer {
    audio: Vec<u8>,
    sample_rate: u32,
    sample_limit: usize,
    stopped: bool,
    warning: Option<String>,
}

impl RecordingBuffer {
    fn configure(&mut self, sample_rate: u32) {
        self.sample_rate = sample_rate;
        self.sample_limit = recording_sample_limit(sample_rate);
        self.audio = encode_pcm_wav(&[], sample_rate);
    }

    fn stop_with_warning(&mut self, warning: String) {
        self.stopped = true;
        if self.warning.is_none() {
            self.warning = Some(warning);
        }
    }

    fn append<T>(&mut self, input: &[T], channels: usize)
    where
        T: Sample + Copy,
        f32: FromSample<T>,
    {
        if self.stopped {
            return;
        }
        let count = self.audio.len().saturating_sub(WAV_HEADER_BYTES) / 2;
        let remaining = self.sample_limit.saturating_sub(count);
        for frame in input.chunks(channels.max(1)).take(remaining) {
            let sample = frame
                .iter()
                .map(|sample| f32::from_sample(*sample))
                .sum::<f32>()
                / frame.len() as f32;
            self.audio
                .extend_from_slice(&sample_to_pcm(sample).to_le_bytes());
        }
        if self.audio.len().saturating_sub(WAV_HEADER_BYTES) / 2 >= self.sample_limit {
            self.stop_with_warning(
                "録音の時間または容量の上限に達したため停止しました。取得済みの音声を処理します。"
                    .into(),
            );
        }
    }
}

fn recording_sample_limit(sample_rate: u32) -> usize {
    (sample_rate as usize)
        .saturating_mul(MAX_RECORDING_SECONDS)
        .min(MAX_PCM_SAMPLES)
}

impl NativeAudioRecorder {
    pub fn start() -> Result<Self, String> {
        let (commands, command_receiver) = mpsc::channel();
        let (ready_sender, ready_receiver) = mpsc::channel();
        let (completed_sender, completed) = mpsc::channel();
        let recording = Arc::new(Mutex::new(RecordingBuffer::default()));
        let worker_recording = Arc::clone(&recording);
        let worker = std::thread::spawn(move || {
            let initialized = initialize_stream(&worker_recording);
            match initialized {
                Ok(stream) => {
                    if ready_sender.send(Ok(())).is_err() {
                        return;
                    }
                    loop {
                        match command_receiver.recv_timeout(Duration::from_millis(100)) {
                            Ok(RecorderCommand::Stop)
                            | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                            Err(mpsc::RecvTimeoutError::Timeout) => {
                                if worker_recording
                                    .lock()
                                    .map(|state| state.stopped)
                                    .unwrap_or(true)
                                {
                                    break;
                                }
                            }
                        }
                    }
                    let _ = stream.pause();
                    drop(stream);
                }
                Err(error) => {
                    let _ = ready_sender.send(Err(error));
                }
            }
            let _ = completed_sender.send(());
        });

        match ready_receiver.recv_timeout(WORKER_TIMEOUT) {
            Ok(Ok(())) => Ok(Self {
                commands,
                worker: Some(worker),
                completed,
                recording,
            }),
            Ok(Err(error)) => {
                if worker.is_finished() {
                    let _ = worker.join();
                }
                Err(error)
            }
            Err(_) => {
                if let Ok(mut state) = recording.lock() {
                    state.stopped = true;
                }
                let _ = commands.send(RecorderCommand::Stop);
                if worker.is_finished() {
                    let _ = worker.join();
                }
                Err(
                    "マイクの準備が時間内に完了しませんでした。接続と権限を確認してください。"
                        .to_string(),
                )
            }
        }
    }

    pub fn stop_reason(&self) -> Option<String> {
        self.recording
            .lock()
            .ok()
            .and_then(|state| state.warning.clone())
    }

    pub fn finish(mut self) -> Result<RecordingResult, String> {
        self.recording
            .lock()
            .map_err(|_| "録音状態を読み取れませんでした。".to_string())?
            .stopped = true;
        let _ = self.commands.send(RecorderCommand::Stop);
        if self.completed.recv_timeout(WORKER_TIMEOUT).is_err() {
            if let Ok(mut state) = self.recording.lock() {
                state.stop_with_warning(
                    "マイクの停止を確認できませんでした。取得済みの音声を回収しました。".into(),
                );
            }
        }
        self.join_completed_worker();
        finish_recording(&self.recording)
    }

    fn join_completed_worker(&mut self) {
        if self.worker.as_ref().is_some_and(JoinHandle::is_finished) {
            if let Some(worker) = self.worker.take() {
                let _ = worker.join();
            }
        }
    }
}

impl Drop for NativeAudioRecorder {
    fn drop(&mut self) {
        if let Ok(mut state) = self.recording.lock() {
            state.stopped = true;
        }
        let _ = self.commands.send(RecorderCommand::Stop);
        self.join_completed_worker();
    }
}

fn preferred_or_fallback_config<T, E>(
    preferred: Result<T, E>,
    fallback: impl IntoIterator<Item = T>,
) -> Result<T, E> {
    preferred.or_else(|error| fallback.into_iter().next().ok_or(error))
}

fn initialize_stream(recording: &Arc<Mutex<RecordingBuffer>>) -> Result<Stream, String> {
    let host = cpal::default_host();
    let default_device = host.default_input_device();
    let fallback_devices = host
        .input_devices()
        .map_err(|error| format!("マイク一覧を読み取れませんでした: {error}"))?;
    let mut attempted_names = Vec::new();
    let mut last_error = None;

    if let Some(device) = default_device {
        attempted_names.push(device.name().unwrap_or_else(|_| "選択中のマイク".into()));
        match initialize_stream_for_device(&device, recording) {
            Ok(stream) => return Ok(stream),
            Err(error) => last_error = Some(error),
        }
    }

    for device in fallback_devices {
        let name = device.name().unwrap_or_else(|_| "別のマイク".into());
        if attempted_names.iter().any(|attempted| attempted == &name) {
            continue;
        }
        attempted_names.push(name);
        match initialize_stream_for_device(&device, recording) {
            Ok(stream) => return Ok(stream),
            Err(error) => last_error = Some(error),
        }
    }

    let device_hint = if attempted_names.is_empty() {
        "使用できるマイクが見つかりません。".to_string()
    } else {
        "選択中のマイクの設定を読み取れませんでした。マイクを一度つなぎ直すか、macOSの「システム設定」→「サウンド」→「入力」で「MacBookのマイク」など別の入力を選び、もう一度試してください。".to_string()
    };
    let _ = last_error;
    Err(device_hint)
}

fn initialize_stream_for_device(
    device: &Device,
    recording: &Arc<Mutex<RecordingBuffer>>,
) -> Result<Stream, String> {
    let fallback_configs = device
        .supported_input_configs()
        .map(|configs| {
            configs
                .map(|config| {
                    config
                        .try_with_sample_rate(cpal::SampleRate(48_000))
                        .unwrap_or_else(|| config.with_max_sample_rate())
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let supported = preferred_or_fallback_config(device.default_input_config(), fallback_configs)
        .map_err(|error| format!("マイクの設定を読み取れませんでした: {error}"))?;
    let sample_rate = supported.sample_rate().0;
    let sample_format = supported.sample_format();
    let config = supported.config();
    recording
        .lock()
        .map_err(|_| "録音状態を準備できませんでした。".to_string())?
        .configure(sample_rate);

    let stream = match sample_format {
        SampleFormat::F32 => build_stream::<f32>(device, &config, recording),
        SampleFormat::F64 => build_stream::<f64>(device, &config, recording),
        SampleFormat::I16 => build_stream::<i16>(device, &config, recording),
        SampleFormat::I32 => build_stream::<i32>(device, &config, recording),
        SampleFormat::U16 => build_stream::<u16>(device, &config, recording),
        SampleFormat::U32 => build_stream::<u32>(device, &config, recording),
        _ => Err(format!(
            "このマイクの音声形式には対応していません: {sample_format}"
        )),
    }?;
    if recording.lock().map(|state| state.stopped).unwrap_or(true) {
        return Err("マイクの準備が取り消されました。".into());
    }
    stream
        .play()
        .map_err(|error| format!("マイクを開始できませんでした: {error}"))?;

    Ok(stream)
}

fn finish_recording(recording: &Arc<Mutex<RecordingBuffer>>) -> Result<RecordingResult, String> {
    let mut state = recording
        .lock()
        .map_err(|_| "録音データを読み取れませんでした。".to_string())?;
    state.stopped = true;
    let mut audio = std::mem::take(&mut state.audio);
    if audio.len() < WAV_HEADER_BYTES {
        return Err(state
            .warning
            .clone()
            .unwrap_or_else(|| "録音データを取得できませんでした。".into()));
    }
    let data_size = (audio.len() - WAV_HEADER_BYTES) as u32;
    audio[4..8].copy_from_slice(&(36 + data_size).to_le_bytes());
    audio[40..44].copy_from_slice(&data_size.to_le_bytes());
    Ok(RecordingResult {
        audio,
        warning: state.warning.clone(),
    })
}

fn build_stream<T>(
    device: &Device,
    config: &StreamConfig,
    recording: &Arc<Mutex<RecordingBuffer>>,
) -> Result<Stream, String>
where
    T: SizedSample + Copy,
    f32: FromSample<T>,
{
    let channels = usize::from(config.channels.max(1));
    let recording_for_input = Arc::clone(recording);
    let recording_for_error = Arc::clone(recording);
    device
        .build_input_stream(
            config,
            move |input: &[T], _| {
                if let Ok(mut target) = recording_for_input.try_lock() {
                    target.append(input, channels);
                }
            },
            move |error| {
                if let Ok(mut current) = recording_for_error.lock() {
                    current.stop_with_warning(format!("録音中にマイクが停止しました: {error}"));
                }
            },
            None,
        )
        .map_err(|error| format!("マイクを開けませんでした: {error}"))
}

pub fn encode_pcm_wav(samples: &[f32], sample_rate: u32) -> Vec<u8> {
    const HEADER_SIZE: usize = 44;
    const BYTES_PER_SAMPLE: usize = 2;
    let data_size = samples.len().saturating_mul(BYTES_PER_SAMPLE);
    let mut wav = Vec::with_capacity(HEADER_SIZE + data_size);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36_u32.saturating_add(data_size as u32)).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16_u32.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes());
    wav.extend_from_slice(&sample_rate.to_le_bytes());
    wav.extend_from_slice(&(sample_rate.saturating_mul(BYTES_PER_SAMPLE as u32)).to_le_bytes());
    wav.extend_from_slice(&(BYTES_PER_SAMPLE as u16).to_le_bytes());
    wav.extend_from_slice(&16_u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&(data_size as u32).to_le_bytes());
    for sample in samples {
        wav.extend_from_slice(&sample_to_pcm(*sample).to_le_bytes());
    }
    wav
}

fn sample_to_pcm(sample: f32) -> i16 {
    let sample = sample.clamp(-1.0, 1.0);
    if sample < 0.0 {
        (sample * 32_768.0) as i16
    } else {
        (sample * 32_767.0) as i16
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn review_rcs008_disconnect_preserves_captured_audio() {
        let mut buffer = RecordingBuffer::default();
        buffer.configure(48_000);
        buffer.append(&[0.25_f32, -0.25, 0.0], 1);
        buffer.stop_with_warning("録音中にマイクが停止しました".into());
        let result = finish_recording(&Arc::new(Mutex::new(buffer)));
        assert!(result.is_ok(), "取得済みの音声を機器エラーで破棄しない");
        let result = result.unwrap();
        assert_eq!(result.audio, encode_pcm_wav(&[0.25, -0.25, 0.0], 48_000));
        assert!(result.warning.unwrap().contains("マイクが停止"));
    }

    #[test]
    fn review_rcs014_pcm_limit_includes_wav_header() {
        let maximum_wav_bytes = 240 * 1024 * 1024;
        assert!(
            44 + MAX_PCM_SAMPLES * 2 <= maximum_wav_bytes,
            "録音上限にWAVヘッダー44バイトを含める"
        );
    }

    #[test]
    fn recording_limits_apply_to_duration_and_bytes_at_each_sample_rate() {
        assert_eq!(recording_sample_limit(48_000), 48_000 * 15 * 60);
        assert_eq!(recording_sample_limit(192_000), MAX_PCM_SAMPLES);
        assert_eq!(44 + recording_sample_limit(192_000) * 2, MAX_WAV_BYTES);
    }

    #[test]
    fn limit_stops_new_samples_and_preserves_first_warning() {
        let mut buffer = RecordingBuffer::default();
        buffer.configure(48_000);
        buffer.sample_limit = 3;
        buffer.append(&[0.1_f32, 0.2], 1);
        assert!(!buffer.stopped);
        buffer.append(&[0.3_f32, 0.4], 1);
        assert!(buffer.stopped);
        let expected = encode_pcm_wav(&[0.1, 0.2, 0.3], 48_000);
        buffer.stop_with_warning("later disconnect".into());
        buffer.append(&[0.5_f32], 1);
        let result = finish_recording(&Arc::new(Mutex::new(buffer))).unwrap();
        assert_eq!(result.audio, expected);
        assert!(result.warning.unwrap().contains("上限"));
    }

    #[test]
    fn early_disconnect_is_reported_and_reconnection_cannot_append() {
        let mut buffer = RecordingBuffer::default();
        buffer.configure(48_000);
        buffer.stop_with_warning("disconnected".into());
        buffer.append(&[0.5_f32], 1);
        let result = finish_recording(&Arc::new(Mutex::new(buffer))).unwrap();
        assert_eq!(result.audio, encode_pcm_wav(&[], 48_000));
        assert_eq!(result.warning.as_deref(), Some("disconnected"));
    }

    #[test]
    fn dropping_recorder_signals_worker_without_waiting_for_it() {
        let (commands, receiver) = mpsc::channel();
        let (_sender, completed) = mpsc::channel();
        let recording = Arc::new(Mutex::new(RecordingBuffer::default()));
        let recorder = NativeAudioRecorder {
            commands,
            worker: None,
            completed,
            recording: Arc::clone(&recording),
        };
        drop(recorder);
        assert!(matches!(
            receiver.recv_timeout(Duration::from_secs(1)),
            Ok(RecorderCommand::Stop)
        ));
        assert!(recording.lock().unwrap().stopped);
    }

    #[test]
    fn finish_recovers_audio_if_worker_exits_without_acknowledging_stop() {
        let (commands, _receiver) = mpsc::channel();
        let (sender, completed) = mpsc::channel();
        drop(sender);
        let mut buffer = RecordingBuffer::default();
        buffer.configure(48_000);
        buffer.append(&[0.25_f32], 1);
        let recorder = NativeAudioRecorder {
            commands,
            worker: None,
            completed,
            recording: Arc::new(Mutex::new(buffer)),
        };
        let result = recorder.finish().unwrap();
        assert_eq!(result.audio, encode_pcm_wav(&[0.25], 48_000));
        assert!(result.warning.unwrap().contains("停止を確認できません"));
    }

    #[test]
    fn finish_returns_captured_audio_after_worker_timeout() {
        let (commands, _receiver) = mpsc::channel();
        let (_sender, completed) = mpsc::channel();
        let mut buffer = RecordingBuffer::default();
        buffer.configure(48_000);
        buffer.append(&[0.25_f32], 1);
        let recorder = NativeAudioRecorder {
            commands,
            worker: None,
            completed,
            recording: Arc::new(Mutex::new(buffer)),
        };
        let result = recorder.finish().unwrap();
        assert_eq!(result.audio, encode_pcm_wav(&[0.25], 48_000));
        assert!(result.warning.unwrap().contains("停止を確認できません"));
    }

    #[test]
    fn stop_reason_exposes_automatic_stop_to_the_monitor() {
        let (commands, _receiver) = mpsc::channel();
        let (_sender, completed) = mpsc::channel();
        let recording = Arc::new(Mutex::new(RecordingBuffer::default()));
        let recorder = NativeAudioRecorder {
            commands,
            worker: None,
            completed,
            recording: Arc::clone(&recording),
        };
        assert!(recorder.stop_reason().is_none());
        recording
            .lock()
            .unwrap()
            .stop_with_warning("disconnected".into());
        assert_eq!(recorder.stop_reason().as_deref(), Some("disconnected"));
    }
}

#[cfg(test)]
mod input_config_fallback_tests {
    use super::*;

    #[test]
    fn falls_back_to_a_supported_config_when_the_default_config_is_unavailable() {
        let config = preferred_or_fallback_config::<u32, _>(Err("CoreAudio error"), [48_000]);
        assert_eq!(config, Ok(48_000));
    }

    #[test]
    fn preserves_the_default_config_when_it_is_available() {
        let config = preferred_or_fallback_config(Ok::<u32, &str>(44_100), [48_000]);
        assert_eq!(config, Ok(44_100));
    }
}

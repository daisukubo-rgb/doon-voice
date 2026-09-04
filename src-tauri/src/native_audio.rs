use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    Device, FromSample, Sample, SampleFormat, SizedSample, Stream, StreamConfig,
};
use std::{
    sync::{
        mpsc::{self, Sender},
        Arc, Mutex,
    },
    thread::JoinHandle,
};

const MAX_PCM_SAMPLES: usize = 120 * 1024 * 1024;

pub struct NativeAudioRecorder {
    commands: Sender<RecorderCommand>,
    worker: Option<JoinHandle<()>>,
}

enum RecorderCommand {
    Finish(Sender<Result<Vec<u8>, String>>),
}

struct InitializedStream {
    stream: Stream,
    samples: Arc<Mutex<Vec<f32>>>,
    stream_error: Arc<Mutex<Option<String>>>,
    sample_rate: u32,
}

impl NativeAudioRecorder {
    pub fn start() -> Result<Self, String> {
        let (commands, command_receiver) = mpsc::channel();
        let (ready_sender, ready_receiver) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let initialized = initialize_stream();
            match initialized {
                Ok(initialized) => {
                    if ready_sender.send(Ok(())).is_err() {
                        return;
                    }
                    let Ok(RecorderCommand::Finish(result_sender)) = command_receiver.recv() else {
                        return;
                    };
                    let _ = initialized.stream.pause();
                    drop(initialized.stream);
                    let result = finish_recording(
                        initialized.samples,
                        initialized.stream_error,
                        initialized.sample_rate,
                    );
                    let _ = result_sender.send(result);
                }
                Err(error) => {
                    let _ = ready_sender.send(Err(error));
                }
            }
        });

        match ready_receiver.recv() {
            Ok(Ok(())) => Ok(Self {
                commands,
                worker: Some(worker),
            }),
            Ok(Err(error)) => {
                let _ = worker.join();
                Err(error)
            }
            Err(_) => {
                let _ = worker.join();
                Err("マイクの準備処理が予期せず終了しました。".to_string())
            }
        }
    }

    pub fn finish(mut self) -> Result<Vec<u8>, String> {
        let (result_sender, result_receiver) = mpsc::channel();
        self.commands
            .send(RecorderCommand::Finish(result_sender))
            .map_err(|_| "録音の停止処理を開始できませんでした。".to_string())?;
        let result = result_receiver
            .recv()
            .map_err(|_| "録音の停止処理が予期せず終了しました。".to_string())?;
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
        result
    }
}

fn initialize_stream() -> Result<InitializedStream, String> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| "使用できるマイクが見つかりません。".to_string())?;
    let supported = device
        .default_input_config()
        .map_err(|error| format!("マイクの設定を読み取れませんでした: {error}"))?;
    let sample_rate = supported.sample_rate().0;
    let sample_format = supported.sample_format();
    let config = supported.config();
    let samples = Arc::new(Mutex::new(Vec::new()));
    let stream_error = Arc::new(Mutex::new(None));

    let stream = match sample_format {
        SampleFormat::F32 => build_stream::<f32>(&device, &config, &samples, &stream_error),
        SampleFormat::F64 => build_stream::<f64>(&device, &config, &samples, &stream_error),
        SampleFormat::I16 => build_stream::<i16>(&device, &config, &samples, &stream_error),
        SampleFormat::I32 => build_stream::<i32>(&device, &config, &samples, &stream_error),
        SampleFormat::U16 => build_stream::<u16>(&device, &config, &samples, &stream_error),
        SampleFormat::U32 => build_stream::<u32>(&device, &config, &samples, &stream_error),
        _ => Err(format!(
            "このマイクの音声形式には対応していません: {sample_format}"
        )),
    }?;
    stream
        .play()
        .map_err(|error| format!("マイクを開始できませんでした: {error}"))?;

    Ok(InitializedStream {
        stream,
        samples,
        stream_error,
        sample_rate,
    })
}

fn finish_recording(
    samples: Arc<Mutex<Vec<f32>>>,
    stream_error: Arc<Mutex<Option<String>>>,
    sample_rate: u32,
) -> Result<Vec<u8>, String> {
    if let Some(error) = stream_error
        .lock()
        .map_err(|_| "録音状態を読み取れませんでした。".to_string())?
        .take()
    {
        return Err(error);
    }
    let samples = samples
        .lock()
        .map_err(|_| "録音データを読み取れませんでした。".to_string())?;
    Ok(encode_pcm_wav(&samples, sample_rate))
}

fn build_stream<T>(
    device: &Device,
    config: &StreamConfig,
    samples: &Arc<Mutex<Vec<f32>>>,
    stream_error: &Arc<Mutex<Option<String>>>,
) -> Result<Stream, String>
where
    T: SizedSample + Copy,
    f32: FromSample<T>,
{
    let channels = usize::from(config.channels.max(1));
    let samples = Arc::clone(samples);
    let stream_error_for_callback = Arc::clone(stream_error);
    device
        .build_input_stream(
            config,
            move |input: &[T], _| {
                if let Ok(mut target) = samples.try_lock() {
                    let remaining = MAX_PCM_SAMPLES.saturating_sub(target.len());
                    target.extend(input.chunks(channels).take(remaining).map(|frame| {
                        frame
                            .iter()
                            .map(|sample| f32::from_sample(*sample))
                            .sum::<f32>()
                            / frame.len() as f32
                    }));
                }
            },
            move |error| {
                if let Ok(mut current) = stream_error_for_callback.lock() {
                    *current = Some(format!("録音中にマイクが停止しました: {error}"));
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
        let sample = sample.clamp(-1.0, 1.0);
        let pcm = if sample < 0.0 {
            (sample * 32_768.0) as i16
        } else {
            (sample * 32_767.0) as i16
        };
        wav.extend_from_slice(&pcm.to_le_bytes());
    }
    wav
}

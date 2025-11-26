import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Hands, HAND_CONNECTIONS } from "@mediapipe/hands";
import type { Results, NormalizedLandmark, Handedness } from "@mediapipe/hands";
import { drawConnectors, drawLandmarks } from "@mediapipe/drawing_utils";
import { Camera } from "@mediapipe/camera_utils";

type GestureName =
  | "张开手掌"
  | "握拳"
  | "食指指向"
  | "剪刀手"
  | "向左摇摆"
  | "向右摇摆"
  | "未知";

type GestureState = {
  label: GestureName;
  confidence: number;
  timestamp: number;
};

type CameraWithStop = InstanceType<typeof Camera> & {
  stop?: () => void;
};

const BASE_STATUS =
  "点击“开始识别”后，授予摄像头权限即可看到实时识别结果。";

const INITIAL_GESTURE: GestureState = {
  label: "未知",
  confidence: 0,
  timestamp: Date.now(),
};

const GESTURE_LABELS: GestureName[] = [
  "张开手掌",
  "握拳",
  "食指指向",
  "剪刀手",
  "向左摇摆",
  "向右摇摆",
  "未知",
];

const WAVE_WINDOW_MS = 900;
const WAVE_THRESHOLD = 0.12;
const WAVE_COOLDOWN_MS = 700;

const useGestureDetector = () => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const handsRef = useRef<Hands | null>(null);
  const cameraRef = useRef<CameraWithStop | null>(null);
  const lastFrameTimeRef = useRef<number>(0);
  const motionTrailRef = useRef<{ x: number; time: number }[]>([]);
  const lastWaveRef = useRef<number>(0);

  const [gesture, setGesture] = useState<GestureState>(INITIAL_GESTURE);
  const [history, setHistory] = useState<GestureState[]>([]);
  const [fps, setFps] = useState(0);
  const [status, setStatus] = useState(BASE_STATUS);
  const [isRunning, setIsRunning] = useState(false);

  const ensureCanvasesSync = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
  }, []);

  const evaluateGesture = useCallback(
    (
      landmarks: NormalizedLandmark[],
      handedness: Handedness["label"] = "Right",
    ) => {
      if (landmarks.length < 21) {
        return INITIAL_GESTURE;
      }

      const isFingerExtended = (tipIndex: number, pipIndex: number) => {
        const tip = landmarks[tipIndex];
        const pip = landmarks[pipIndex];
        return tip.y < pip.y - 0.02;
      };

      const thumbTip = landmarks[4];
      const thumbIP = landmarks[3];
      const thumbExtended =
        handedness === "Right"
          ? thumbTip.x < thumbIP.x - 0.02
          : thumbTip.x > thumbIP.x + 0.02;

      const fingerStates = [
        thumbExtended,
        isFingerExtended(8, 6),
        isFingerExtended(12, 10),
        isFingerExtended(16, 14),
        isFingerExtended(20, 18),
      ];

      const extendedCount = fingerStates.filter(Boolean).length;
      let label: GestureName = "未知";
      let confidence = 0;

      if (fingerStates.every(Boolean)) {
        label = "张开手掌";
        confidence = Math.min(1, extendedCount / 5);
      } else if (fingerStates.slice(1).every((state) => !state)) {
        label = "握拳";
        confidence = 1 - extendedCount / 5;
      } else if (
        fingerStates[1] &&
        fingerStates.slice(2).every((state) => !state)
      ) {
        label = "食指指向";
        confidence = 0.7;
      } else if (
        fingerStates[1] &&
        fingerStates[2] &&
        !fingerStates[3] &&
        !fingerStates[4]
      ) {
        label = "剪刀手";
        confidence = 0.8;
      }

      return {
        label,
        confidence: Number(confidence.toFixed(2)),
        timestamp: Date.now(),
      };
    },
    [],
  );

  const detectWaveGesture = useCallback(
    (
      landmarks: NormalizedLandmark[],
      baseGesture: GestureName,
    ): GestureState | null => {
      if (baseGesture !== "张开手掌") {
        motionTrailRef.current = [];
        return null;
      }

      const wrist = landmarks[0];
      if (!wrist) {
        return null;
      }

      const now = performance.now();
      motionTrailRef.current = [
        ...motionTrailRef.current.filter(
          (sample) => now - sample.time <= WAVE_WINDOW_MS,
        ),
        { x: wrist.x, time: now },
      ];

      if (motionTrailRef.current.length < 3) {
        return null;
      }

      const first = motionTrailRef.current[0];
      const last = motionTrailRef.current[motionTrailRef.current.length - 1];
      const delta = last.x - first.x;

      if (Math.abs(delta) < WAVE_THRESHOLD) {
        return null;
      }

      if (now - lastWaveRef.current < WAVE_COOLDOWN_MS) {
        return null;
      }

      lastWaveRef.current = now;
      const isMovingRight = delta > 0;
      const label: GestureName = isMovingRight ? "向右摇摆" : "向左摇摆";
      const confidence = Math.min(1, Math.abs(delta) / 0.3);
      return {
        label,
        confidence: Number(confidence.toFixed(2)),
        timestamp: Date.now(),
      };
    },
    [],
  );

  const handleResults = useCallback(
    (results: Results) => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) {
        return;
      }

      ensureCanvasesSync();
      ctx.save();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (results.image) {
        ctx.drawImage(results.image, 0, 0, canvas.width, canvas.height);
      }

      const landmarks = results.multiHandLandmarks?.[0];
      const handedness = results.multiHandedness?.[0];

      if (landmarks) {
        drawConnectors(ctx, landmarks, HAND_CONNECTIONS, {
          color: "#4fd1c5",
          lineWidth: 4,
        });
        drawLandmarks(ctx, landmarks, {
          color: "#f6ad55",
          lineWidth: 2,
        });

        const staticGesture = evaluateGesture(
          landmarks,
          handedness?.label ?? "Right",
        );
        const wavingGesture = detectWaveGesture(landmarks, staticGesture.label);
        const nextGesture = wavingGesture ?? staticGesture;

        setGesture((prev) => {
          if (nextGesture.label !== "未知" && nextGesture.label !== prev.label) {
            setHistory((current) => {
              const next = [nextGesture, ...current];
              return next.slice(0, 6);
            });
          }
          return nextGesture;
        });
      } else {
        setGesture(INITIAL_GESTURE);
        motionTrailRef.current = [];
      }

      ctx.restore();

      const now = performance.now();
      const elapsed = now - lastFrameTimeRef.current;
      if (elapsed > 0) {
        setFps(Number((1000 / elapsed).toFixed(1)));
      }
      lastFrameTimeRef.current = now;
    },
    [detectWaveGesture, ensureCanvasesSync, evaluateGesture],
  );

  const loadHands = useCallback(() => {
    const hands = new Hands({
      locateFile: (file) =>
        `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
    });
    hands.setOptions({
      modelComplexity: 1,
      maxNumHands: 1,
      minDetectionConfidence: 0.7,
      minTrackingConfidence: 0.4,
    });
    hands.onResults(handleResults);
    handsRef.current = hands;
  }, [handleResults]);

  const start = useCallback(async () => {
    if (isRunning) {
      return;
    }
    const videoElement = videoRef.current;
    if (!videoElement) {
      setStatus("找不到视频元素，刷新页面后重试。");
      return;
    }
    if (!handsRef.current) {
      loadHands();
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480 },
      });
      videoElement.srcObject = stream;
      await videoElement.play();
    } catch (err) {
      setStatus("无法访问摄像头，请检查权限设置。");
      return;
    }

    ensureCanvasesSync();
    const camera = new Camera(videoElement, {
      onFrame: async () => {
        if (!handsRef.current) {
          return;
        }
        await handsRef.current.send({ image: videoElement });
      },
      width: 640,
      height: 480,
    }) as CameraWithStop;

    camera.start();
    cameraRef.current = camera;
    setIsRunning(true);
    setStatus("正在识别手势...");
  }, [ensureCanvasesSync, isRunning, loadHands]);

  const stop = useCallback(() => {
    const videoElement = videoRef.current;
    cameraRef.current?.stop?.();
    cameraRef.current = null;
    handsRef.current?.close();
    handsRef.current = null;
    motionTrailRef.current = [];
    lastWaveRef.current = 0;

    if (videoElement?.srcObject) {
      const mediaStream = videoElement.srcObject as MediaStream;
      mediaStream.getTracks().forEach((track) => track.stop());
      videoElement.srcObject = null;
    }

    setGesture(INITIAL_GESTURE);
    setStatus(BASE_STATUS);
    setIsRunning(false);
    setFps(0);
  }, []);

  useEffect(() => {
    return () => {
      stop();
    };
  }, [stop]);

  const activeGestureLabel = useMemo(() => gesture.label, [gesture.label]);

  return {
    videoRef,
    canvasRef,
    gesture,
    history,
    fps,
    status,
    isRunning,
    start,
    stop,
    activeGestureLabel,
  };
};

const App: React.FC = () => {
  const {
    videoRef,
    canvasRef,
    gesture,
    history,
    fps,
    status,
    isRunning,
    start,
    stop,
    activeGestureLabel,
  } = useGestureDetector();

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Gesture Vision</p>
          <h1>实时手势识别</h1>
          <p className="tagline">
            基于 MediaPipe Hands，识别常见静态手势并实时显示骨架。
          </p>
        </div>
        <div className="header-actions">
          <button
            className="primary"
            onClick={start}
            disabled={isRunning}
            aria-label="开始识别"
          >
            {isRunning ? "识别中" : "开始识别"}
          </button>
          <button
            className="ghost"
            onClick={stop}
            disabled={!isRunning}
            aria-label="停止识别"
          >
            停止
          </button>
        </div>
      </header>

      <main className="main-grid">
        <section className="stage-card">
          <div className="canvas-wrapper">
            <video ref={videoRef} className="hidden-video" playsInline />
            <canvas ref={canvasRef} aria-label="手势识别画布" />
          </div>
          <div className="status-bar">
            <span>状态：{status}</span>
            <span>FPS：{fps || "--"}</span>
          </div>
        </section>

        <section className="info-panel">
          <div className="current-gesture">
            <p className="label">当前手势</p>
            <h2 className="gesture-name">{activeGestureLabel}</h2>
            <p className="confidence">
              可信度：{Math.round(gesture.confidence * 100)}%
            </p>
          </div>

          <div className="history">
            <p className="label">最近识别</p>
            {history.length === 0 ? (
              <p className="placeholder">暂无识别记录</p>
            ) : (
              <ul>
                {history.map((item) => (
                  <li key={item.timestamp}>
                    <span>{item.label}</span>
                    <span>{new Date(item.timestamp).toLocaleTimeString()}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="legend">
            <p className="label">支持的手势</p>
            <div className="pills">
              {GESTURE_LABELS.filter((label) => label !== "未知").map(
                (label) => (
                  <span key={label} className="pill">
                    {label}
                  </span>
                ),
              )}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
};

export default App;




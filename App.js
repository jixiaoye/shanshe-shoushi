import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useMemo, useRef, useState, } from "react";
import { Hands, HAND_CONNECTIONS } from "@mediapipe/hands";
import { drawConnectors, drawLandmarks } from "@mediapipe/drawing_utils";
import { Camera } from "@mediapipe/camera_utils";
const BASE_STATUS = "点击“开始识别”后，授予摄像头权限即可看到实时识别结果。";
const INITIAL_GESTURE = {
    label: "未知",
    confidence: 0,
    timestamp: Date.now(),
};
const GESTURE_LABELS = [
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
    const videoRef = useRef(null);
    const canvasRef = useRef(null);
    const handsRef = useRef(null);
    const cameraRef = useRef(null);
    const lastFrameTimeRef = useRef(0);
    const motionTrailRef = useRef([]);
    const lastWaveRef = useRef(0);
    const [gesture, setGesture] = useState(INITIAL_GESTURE);
    const [history, setHistory] = useState([]);
    const [fps, setFps] = useState(0);
    const [status, setStatus] = useState(BASE_STATUS);
    const [isRunning, setIsRunning] = useState(false);
    const ensureCanvasesSync = useCallback(() => {
        const video = videoRef.current;
        const canvas = canvasRef.current;
        if (!video || !canvas)
            return;
        canvas.width = video.videoWidth || 640;
        canvas.height = video.videoHeight || 480;
    }, []);
    const evaluateGesture = useCallback((landmarks, handedness = "Right") => {
        if (landmarks.length < 21) {
            return INITIAL_GESTURE;
        }
        const isFingerExtended = (tipIndex, pipIndex) => {
            const tip = landmarks[tipIndex];
            const pip = landmarks[pipIndex];
            return tip.y < pip.y - 0.02;
        };
        const thumbTip = landmarks[4];
        const thumbIP = landmarks[3];
        const thumbExtended = handedness === "Right"
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
        let label = "未知";
        let confidence = 0;
        if (fingerStates.every(Boolean)) {
            label = "张开手掌";
            confidence = Math.min(1, extendedCount / 5);
        }
        else if (fingerStates.slice(1).every((state) => !state)) {
            label = "握拳";
            confidence = 1 - extendedCount / 5;
        }
        else if (fingerStates[1] &&
            fingerStates.slice(2).every((state) => !state)) {
            label = "食指指向";
            confidence = 0.7;
        }
        else if (fingerStates[1] &&
            fingerStates[2] &&
            !fingerStates[3] &&
            !fingerStates[4]) {
            label = "剪刀手";
            confidence = 0.8;
        }
        return {
            label,
            confidence: Number(confidence.toFixed(2)),
            timestamp: Date.now(),
        };
    }, []);
    const detectWaveGesture = useCallback((landmarks, baseGesture) => {
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
            ...motionTrailRef.current.filter((sample) => now - sample.time <= WAVE_WINDOW_MS),
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
        const label = isMovingRight ? "向右摇摆" : "向左摇摆";
        const confidence = Math.min(1, Math.abs(delta) / 0.3);
        return {
            label,
            confidence: Number(confidence.toFixed(2)),
            timestamp: Date.now(),
        };
    }, []);
    const handleResults = useCallback((results) => {
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
            const staticGesture = evaluateGesture(landmarks, handedness?.label ?? "Right");
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
        }
        else {
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
    }, [detectWaveGesture, ensureCanvasesSync, evaluateGesture]);
    const loadHands = useCallback(() => {
        const hands = new Hands({
            locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
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
        }
        catch (err) {
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
        });
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
            const mediaStream = videoElement.srcObject;
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
const App = () => {
    const { videoRef, canvasRef, gesture, history, fps, status, isRunning, start, stop, activeGestureLabel, } = useGestureDetector();
    return (_jsxs("div", { className: "app-shell", children: [_jsxs("header", { className: "app-header", children: [_jsxs("div", { children: [_jsx("p", { className: "eyebrow", children: "Gesture Vision" }), _jsx("h1", { children: "\u5B9E\u65F6\u624B\u52BF\u8BC6\u522B" }), _jsx("p", { className: "tagline", children: "\u57FA\u4E8E MediaPipe Hands\uFF0C\u8BC6\u522B\u5E38\u89C1\u9759\u6001\u624B\u52BF\u5E76\u5B9E\u65F6\u663E\u793A\u9AA8\u67B6\u3002" })] }), _jsxs("div", { className: "header-actions", children: [_jsx("button", { className: "primary", onClick: start, disabled: isRunning, "aria-label": "\u5F00\u59CB\u8BC6\u522B", children: isRunning ? "识别中" : "开始识别" }), _jsx("button", { className: "ghost", onClick: stop, disabled: !isRunning, "aria-label": "\u505C\u6B62\u8BC6\u522B", children: "\u505C\u6B62" })] })] }), _jsxs("main", { className: "main-grid", children: [_jsxs("section", { className: "stage-card", children: [_jsxs("div", { className: "canvas-wrapper", children: [_jsx("video", { ref: videoRef, className: "hidden-video", playsInline: true }), _jsx("canvas", { ref: canvasRef, "aria-label": "\u624B\u52BF\u8BC6\u522B\u753B\u5E03" })] }), _jsxs("div", { className: "status-bar", children: [_jsxs("span", { children: ["\u72B6\u6001\uFF1A", status] }), _jsxs("span", { children: ["FPS\uFF1A", fps || "--"] })] })] }), _jsxs("section", { className: "info-panel", children: [_jsxs("div", { className: "current-gesture", children: [_jsx("p", { className: "label", children: "\u5F53\u524D\u624B\u52BF" }), _jsx("h2", { className: "gesture-name", children: activeGestureLabel }), _jsxs("p", { className: "confidence", children: ["\u53EF\u4FE1\u5EA6\uFF1A", Math.round(gesture.confidence * 100), "%"] })] }), _jsxs("div", { className: "history", children: [_jsx("p", { className: "label", children: "\u6700\u8FD1\u8BC6\u522B" }), history.length === 0 ? (_jsx("p", { className: "placeholder", children: "\u6682\u65E0\u8BC6\u522B\u8BB0\u5F55" })) : (_jsx("ul", { children: history.map((item) => (_jsxs("li", { children: [_jsx("span", { children: item.label }), _jsx("span", { children: new Date(item.timestamp).toLocaleTimeString() })] }, item.timestamp))) }))] }), _jsxs("div", { className: "legend", children: [_jsx("p", { className: "label", children: "\u652F\u6301\u7684\u624B\u52BF" }), _jsx("div", { className: "pills", children: GESTURE_LABELS.filter((label) => label !== "未知").map((label) => (_jsx("span", { className: "pill", children: label }, label))) })] })] })] })] }));
};
export default App;

"use client";

import { useEffect, useRef, useState } from "react";

type IControlsLike = { stop: () => void };
type IReaderLike = {
  decodeFromVideoDevice: (
    deviceId: string | undefined,
    el: HTMLVideoElement | null,
    cb: (result: unknown, err: unknown, ctrl: IControlsLike) => void,
  ) => Promise<IControlsLike>;
  decodeFromCanvas?: (canvas: HTMLCanvasElement) => unknown;
};

function rotateCanvas(src: HTMLCanvasElement, angle: number): HTMLCanvasElement {
  const swap = angle === 90 || angle === 270;
  const w = swap ? src.height : src.width;
  const h = swap ? src.width : src.height;
  const dst = document.createElement("canvas");
  dst.width = w;
  dst.height = h;
  const ctx = dst.getContext("2d");
  if (!ctx) return src;
  ctx.translate(w / 2, h / 2);
  ctx.rotate((angle * Math.PI) / 180);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return dst;
}

// Mount/unmount-on-open pattern: parent renders `{open ? <BarcodeScanner /> :
// null}` and the camera lifecycle, dialog open/close, and initial state are
// all tied to the React lifecycle (no derived `open` prop). This avoids the
// "setState inside effect" anti-pattern that would arise from resetting
// state when `open` flips.
export function BarcodeScanner({
  onClose,
  onDetect,
  title = "Scan tracking barcode",
}: {
  onClose: () => void;
  onDetect: (code: string) => void;
  title?: string;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const controlsRef = useRef<IControlsLike | null>(null);
  const readerRef = useRef<IReaderLike | null>(null);
  const onDetectRef = useRef(onDetect);
  useEffect(() => {
    onDetectRef.current = onDetect;
  }, [onDetect]);

  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(true);
  const [manual, setManual] = useState("");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [captureMsg, setCaptureMsg] = useState<string | null>(null);

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const mod = await import("@zxing/browser");
        if (cancelled) return;
        const Reader = (
          mod as unknown as {
            BrowserMultiFormatReader: {
              new (): IReaderLike;
              listVideoInputDevices: () => Promise<MediaDeviceInfo[]>;
            };
          }
        ).BrowserMultiFormatReader;
        const reader = new Reader();
        readerRef.current = reader;

        let cams: MediaDeviceInfo[] = [];
        try {
          cams = await Reader.listVideoInputDevices();
          if (cancelled) return;
          setDevices(cams);
        } catch {
          // listVideoInputDevices may require an already-granted permission.
        }

        const preferred =
          cams.find((d) => /back|rear|environment/i.test(d.label))?.deviceId ??
          cams[0]?.deviceId ??
          null;
        const chosen = deviceId || preferred;
        if (chosen !== deviceId) setDeviceId(chosen);

        const controls = await reader.decodeFromVideoDevice(
          chosen ?? undefined,
          videoRef.current,
          (result, _err, ctrl) => {
            if (result) {
              const text =
                (result as { getText?: () => string }).getText?.() ??
                String(result);
              ctrl.stop();
              controlsRef.current = null;
              onDetectRef.current?.(text);
            }
          },
        );
        if (cancelled) {
          controls.stop();
          return;
        }
        controlsRef.current = controls;
        setStarting(false);
      } catch (e) {
        if (cancelled) return;
        const err = e as { name?: string; message?: string };
        setError(
          err?.name === "NotAllowedError"
            ? "Camera permission denied. Allow camera access and try again."
            : err?.name === "NotFoundError"
              ? "No camera found on this device."
              : err?.message || "Could not start camera.",
        );
        setStarting(false);
      }
    })();

    return () => {
      cancelled = true;
      try {
        controlsRef.current?.stop();
      } catch {
        // already stopped
      }
      controlsRef.current = null;
      readerRef.current = null;
    };
  }, [deviceId]);

  function submitManual() {
    const code = manual.trim();
    if (!code) return;
    setManual("");
    onDetect(code);
  }

  async function tryDecodeCanvas(canvas: HTMLCanvasElement): Promise<string | null> {
    if (
      typeof window !== "undefined" &&
      "BarcodeDetector" in window &&
      typeof (window as unknown as { BarcodeDetector: unknown }).BarcodeDetector ===
        "function"
    ) {
      try {
        const Ctor = (
          window as unknown as {
            BarcodeDetector: new (opts: { formats: string[] }) => {
              detect: (img: CanvasImageSource) => Promise<
                Array<{ rawValue: string }>
              >;
            };
          }
        ).BarcodeDetector;
        const detector = new Ctor({
          formats: [
            "ean_13",
            "ean_8",
            "upc_a",
            "upc_e",
            "code_128",
            "code_39",
            "code_93",
            "codabar",
            "itf",
            "qr_code",
            "data_matrix",
          ],
        });
        const codes = await detector.detect(canvas);
        if (codes?.[0]?.rawValue) return codes[0].rawValue;
      } catch {
        // fall through to ZXing
      }
    }
    const reader = readerRef.current;
    if (!reader?.decodeFromCanvas) return null;
    for (const angle of [0, 180, 90, 270]) {
      const c = angle === 0 ? canvas : rotateCanvas(canvas, angle);
      try {
        const r = reader.decodeFromCanvas(c);
        const t = (r as { getText?: () => string })?.getText?.() ?? null;
        if (t) return t;
      } catch {
        // try the next rotation
      }
    }
    return null;
  }

  async function captureFrame() {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    setCapturing(true);
    setCaptureMsg(null);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d")?.drawImage(video, 0, 0);
      const text = await tryDecodeCanvas(canvas);
      if (!text) {
        setCaptureMsg("Couldn't read this image. Line it up and try again.");
        return;
      }
      try {
        controlsRef.current?.stop();
      } catch {
        // already stopped
      }
      controlsRef.current = null;
      onDetect(text);
    } finally {
      setCapturing(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      className="w-full max-w-md rounded-lg border border-zinc-200 bg-white p-0 shadow-xl backdrop:bg-zinc-900/40"
    >
      <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3">
        <h2 className="text-sm font-semibold text-zinc-900">{title}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded p-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
        >
          ×
        </button>
      </div>

      <div className="space-y-3 p-5">
        <p className="text-xs text-zinc-500">
          Point the camera at the tracking barcode. Detection is automatic.
        </p>

        {error ? (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        ) : (
          <div className="relative aspect-video overflow-hidden rounded-md bg-zinc-900">
            <video
              ref={videoRef}
              className="h-full w-full object-cover"
              muted
              playsInline
            />
            {starting ? (
              <div className="absolute inset-0 flex items-center justify-center bg-zinc-900/70 text-xs text-white">
                Starting camera…
              </div>
            ) : null}
            <div className="pointer-events-none absolute inset-6 rounded-md border-2 border-emerald-400/70" />
          </div>
        )}

        {!error ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={captureFrame}
              disabled={starting || capturing}
              className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
            >
              {capturing ? "Reading frame…" : "Capture frame"}
            </button>
            <span className="text-[11px] text-zinc-500">
              Auto-detect not catching it? Line it up and press Capture.
            </span>
          </div>
        ) : null}

        {captureMsg ? (
          <p className="text-[11px] text-red-600">{captureMsg}</p>
        ) : null}

        {devices.length > 1 ? (
          <div>
            <label className="block text-xs font-medium text-zinc-700">
              Camera
            </label>
            <select
              value={deviceId ?? ""}
              onChange={(e) => setDeviceId(e.target.value)}
              className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm text-zinc-900"
            >
              {devices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Camera ${d.deviceId.slice(0, 6)}`}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        <div>
          <label className="block text-xs font-medium text-zinc-700">
            Or enter code manually
          </label>
          <div className="mt-1 flex gap-2">
            <input
              type="text"
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submitManual();
                }
              }}
              placeholder="Type or paste a barcode"
              className="flex-1 rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm text-zinc-900 outline-none focus:border-zinc-900"
            />
            <button
              type="button"
              onClick={submitManual}
              disabled={!manual.trim()}
              className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
            >
              Submit
            </button>
          </div>
        </div>
      </div>
    </dialog>
  );
}

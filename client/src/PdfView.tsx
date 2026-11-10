import { useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export type SharedState = {
  started: boolean;
  currentId: string | null;
  title: string;
  page: number;
  pages: number;
};

export const emptyState: SharedState = { started: false, currentId: null, title: "", page: 1, pages: 0 };

export function usePdf(url: string | null, token?: string) {
  const [doc, setDoc] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setDoc(null);
    setError("");
    if (!url) return;
    let cancelled = false;
    const task = pdfjs.getDocument({ url, httpHeaders: token ? { Authorization: `Bearer ${token}` } : undefined });
    task.promise.then(
      (loaded) => !cancelled && setDoc(loaded),
      () => !cancelled && setError("The slides could not be loaded."),
    );
    return () => {
      cancelled = true;
      task.destroy();
    };
  }, [url, token]);

  return { doc, error };
}

type LeafProps = { doc: pdfjs.PDFDocumentProxy; n: number; width: number; height: number };

// One rendered slide. Drawn at device resolution so it stays sharp on large screens.
function Leaf({ doc, n, width, height }: LeafProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let job: pdfjs.RenderTask | null = null;
    let stale = false;
    doc.getPage(n).then((pdfPage) => {
      const canvas = canvasRef.current;
      if (stale || !canvas || width <= 0 || height <= 0) return;
      const base = pdfPage.getViewport({ scale: 1 });
      const fit = Math.min(width / base.width, height / base.height);
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = pdfPage.getViewport({ scale: fit * ratio });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${Math.floor(viewport.width / ratio)}px`;
      canvas.style.height = `${Math.floor(viewport.height / ratio)}px`;
      job = pdfPage.render({ canvasContext: canvas.getContext("2d")!, viewport });
      job.promise.catch(() => {});
    }).catch(() => {});
    return () => {
      stale = true;
      job?.cancel();
    };
  }, [doc, n, width, height]);

  return <canvas ref={canvasRef} />;
}

// Slides shown as pages of a book: the current page turns over when `page` changes.
export function Flipbook({ doc, page }: { doc: pdfjs.PDFDocumentProxy; page: number }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [ratio, setRatio] = useState(16 / 9);

  useEffect(() => {
    let stale = false;
    doc.getPage(1).then((first) => {
      const view = first.getViewport({ scale: 1 });
      if (!stale) setRatio(view.width / view.height);
    });
    return () => {
      stale = true;
    };
  }, [doc]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => setBox({ w: stage.clientWidth, h: stage.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  const total = doc.numPages;
  const current = Math.min(Math.max(page, 1), total);
  const width = Math.floor(Math.min(box.w, box.h * ratio));
  const height = Math.floor(width / ratio);

  const leaves = [];
  for (let n = Math.max(1, current - 2); n <= Math.min(total, current + 3); n++) {
    leaves.push(
      <div key={n} className={n < current ? "leaf flipped" : "leaf"} style={{ zIndex: total - n }}>
        <Leaf doc={doc} n={n} width={width} height={height} />
      </div>,
    );
  }

  return (
    <div className="book-stage" ref={stageRef}>
      <div className="book" style={{ width, height }}>
        {leaves}
      </div>
    </div>
  );
}

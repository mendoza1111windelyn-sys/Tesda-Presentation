import { useEffect, useRef } from "react";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export type SharedState = {
  started: boolean;
  currentId: string | null;
  title: string;
  page: number;
  pages: number;
  live: boolean;
};

export const emptyState: SharedState = { started: false, currentId: null, title: "", page: 1, pages: 0, live: false };

type Props = {
  url: string;
  token?: string;
  page: number;
  onLoaded?: (pages: number) => void;
};

export function PdfView({ url, token, page, onLoaded }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const docRef = useRef<pdfjs.PDFDocumentProxy | null>(null);
  const loadedRef = useRef(onLoaded);
  loadedRef.current = onLoaded;
  const pageRef = useRef(page);
  pageRef.current = page;
  const renderRef = useRef<() => void>(() => {});

  useEffect(() => {
    let cancelled = false;
    const task = pdfjs.getDocument({ url, httpHeaders: token ? { Authorization: `Bearer ${token}` } : undefined });
    task.promise.then((doc) => {
      if (cancelled) return;
      docRef.current = doc;
      loadedRef.current?.(doc.numPages);
      renderRef.current();
    });
    return () => {
      cancelled = true;
      docRef.current = null;
      task.destroy();
    };
  }, [url, token]);

  useEffect(() => {
    let job: pdfjs.RenderTask | null = null;
    let version = 0;
    renderRef.current = async () => {
      const doc = docRef.current;
      const wrap = wrapRef.current;
      const canvas = canvasRef.current;
      if (!doc || !wrap || !canvas) return;
      const mine = ++version;
      const pageNumber = Math.min(Math.max(pageRef.current, 1), doc.numPages);
      const pdfPage = await doc.getPage(pageNumber);
      if (mine !== version) return;
      const base = pdfPage.getViewport({ scale: 1 });
      const scale = Math.min(wrap.clientWidth / base.width, wrap.clientHeight / base.height);
      if (!(scale > 0)) return;
      const ratio = window.devicePixelRatio || 1;
      const viewport = pdfPage.getViewport({ scale: scale * ratio });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${Math.floor(viewport.width / ratio)}px`;
      canvas.style.height = `${Math.floor(viewport.height / ratio)}px`;
      job?.cancel();
      job = pdfPage.render({ canvasContext: canvas.getContext("2d")!, viewport });
      job.promise.catch(() => {});
    };
    renderRef.current();
    const observer = new ResizeObserver(() => renderRef.current());
    if (wrapRef.current) observer.observe(wrapRef.current);
    return () => {
      observer.disconnect();
      job?.cancel();
    };
  }, []);

  useEffect(() => {
    renderRef.current();
  }, [page]);

  return (
    <div className="pdf-wrap" ref={wrapRef}>
      <canvas ref={canvasRef} />
    </div>
  );
}

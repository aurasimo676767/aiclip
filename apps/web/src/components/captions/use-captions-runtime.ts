"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

/** Larghezza di un elemento, aggiornata quando cambia (serve a scalare i sottotitoli al riquadro). */
export function useElementWidth<T extends HTMLElement>(): [RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width));
    ro.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/**
 * Tempo del video letto a ogni fotogramma mentre suona (timeupdate arriva solo ~4 volte al secondo:
 * le parole cambierebbero in ritardo), e su seek/pausa.
 */
export function useVideoTime(videoRef: RefObject<HTMLVideoElement>): number {
  const [time, setTime] = useState(0);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let raf = 0;
    const tick = () => {
      setTime(video.currentTime);
      if (!video.paused && !video.ended) raf = requestAnimationFrame(tick);
    };
    const start = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
    };
    const sync = () => setTime(video.currentTime);
    video.addEventListener("play", start);
    video.addEventListener("seeked", sync);
    video.addEventListener("timeupdate", sync);
    video.addEventListener("loadedmetadata", sync);
    return () => {
      cancelAnimationFrame(raf);
      video.removeEventListener("play", start);
      video.removeEventListener("seeked", sync);
      video.removeEventListener("timeupdate", sync);
      video.removeEventListener("loadedmetadata", sync);
    };
  }, [videoRef]);
  return time;
}

/** Orologio finto che gira in loop da 0 a `period` secondi, fermo quando l'elemento non si vede. */
export function useLoopClock(period: number, target: RefObject<HTMLElement>, running = true): number {
  const [t, setT] = useState(0);
  useEffect(() => {
    const el = target.current;
    if (!el || !running) return;
    let raf = 0;
    let visible = false;
    let origin = performance.now();
    const tick = (now: number) => {
      setT(((now - origin) / 1000) % period);
      if (visible) raf = requestAnimationFrame(tick);
    };
    const io = new IntersectionObserver(([entry]) => {
      visible = entry!.isIntersecting;
      cancelAnimationFrame(raf);
      if (visible) {
        origin = performance.now();
        raf = requestAnimationFrame(tick);
      }
    });
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [period, target, running]);
  return t;
}

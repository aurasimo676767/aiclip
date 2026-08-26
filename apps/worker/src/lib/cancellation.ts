import { supabase } from "./supabase.js";

/**
 * Controlla se l'utente ha richiesto l'annullamento tramite la dashboard (bottone "Annulla").
 * Va richiamato tra uno stadio e l'altro della pipeline (non può interrompere una singola
 * chiamata già in volo, es. whisper o ffmpeg già avviati) per evitare di eseguire gli stadi
 * successivi, in genere i più costosi (AI, render).
 */
export async function isVideoCancelled(videoId: string): Promise<boolean> {
  const { data } = await supabase.from("videos").select("cancel_requested").eq("id", videoId).single();
  return data?.cancel_requested === true;
}

export async function isRenderJobCancelled(jobId: string): Promise<boolean> {
  const { data } = await supabase.from("render_jobs").select("cancel_requested").eq("id", jobId).single();
  return data?.cancel_requested === true;
}

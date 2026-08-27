import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// youtube.upload basta per caricare, ma NON per modificare lo stato (privacy/programmazione)
// di un video già caricato — videos.update con part=status richiede lo scope pieno "youtube"
// (osservato in pratica: "Request had insufficient authentication scopes" sull'annullamento
// programmazione, che chiama esattamente questo endpoint).
const SCOPES = ["https://www.googleapis.com/auth/youtube", "https://www.googleapis.com/auth/youtube.readonly"];

/** Avvia il flusso OAuth Google: reindirizza l'utente alla schermata di consenso. */
export async function GET(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json({ error: "GOOGLE_CLIENT_ID mancante nell'ambiente server" }, { status: 500 });
  }

  const redirectUri = new URL("/api/youtube/callback", request.url).toString();

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    scope: SCOPES.join(" "),
  });

  return NextResponse.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
}

/**
 * Tipi TypeScript per lo schema Postgres definito in migrations/0001_init.sql.
 * Scritti a mano (nessun progetto Supabase live da cui generare `supabase gen types`
 * in questa fase) — se lo schema cambia, aggiorna sia il file SQL sia questo file.
 *
 * IMPORTANTE: ogni Row/Insert/Update qui sotto è scritto come oggetto letterale INLINE
 * dentro `Database`, esattamente come fa `supabase gen types typescript`. supabase-js
 * risolve i tipi delle query (`.from().update()`, `.rpc()`, ...) attraverso una catena di
 * conditional type che fa pattern-matching sulla FORMA letterale di Row/Insert/Update:
 * se una di queste viene sostituita con un riferimento a un'interfaccia con nome (anche
 * senza generici/Partial/Pick), quella catena si rompe silenziosamente e ogni query
 * finisce per risolvere a `never`. I tipi "comodi" con nome (VideoRow, ClipInsert, ...)
 * sono quindi derivati DOPO, con un indexed access su `Database` — mai il contrario.
 */

export type Plan = "FREE" | "PRO" | "BUSINESS";

export type ProjectStatus =
  | "UPLOADING"
  | "UPLOADED"
  | "DOWNLOADING"
  | "EXTRACTING_AUDIO"
  | "TRANSCRIBING"
  | "ANALYZING"
  | "CLIP_SELECTION"
  | "READY"
  | "FAILED";

export type ClipStatus = "SUGGESTED" | "QUEUED" | "RENDERING" | "COMPLETED" | "FAILED";

export type RenderJobStatus = "PENDING" | "RENDERING" | "COMPLETED" | "FAILED";

export type YoutubePublishStatus = "PENDING" | "UPLOADING" | "COMPLETED" | "FAILED";

export type YoutubePrivacyStatus = "public" | "unlisted" | "private";

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          email: string;
          plan: Plan;
          credits: number;
          processing_minutes_used: number;
          storage_used_bytes: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          email: string;
          plan?: Plan;
          credits?: number;
          processing_minutes_used?: number;
          storage_used_bytes?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          email?: string;
          plan?: Plan;
          credits?: number;
          processing_minutes_used?: number;
          storage_used_bytes?: number;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };

      projects: {
        Row: {
          id: string;
          user_id: string;
          title: string;
          status: ProjectStatus;
          source_type: "upload" | "youtube_url";
          error_message: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          title: string;
          status?: ProjectStatus;
          source_type: "upload" | "youtube_url";
          error_message?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          title?: string;
          status?: ProjectStatus;
          source_type?: "upload" | "youtube_url";
          error_message?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };

      videos: {
        Row: {
          id: string;
          project_id: string;
          storage_path: string | null;
          original_filename: string;
          source_url: string | null;
          duration_seconds: number | null;
          size_bytes: number | null;
          mime_type: string | null;
          status: ProjectStatus;
          error_message: string | null;
          claimed_by: string | null;
          claimed_at: string | null;
          attempts: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          project_id: string;
          storage_path?: string | null;
          original_filename: string;
          source_url?: string | null;
          duration_seconds?: number | null;
          size_bytes?: number | null;
          mime_type?: string | null;
          status?: ProjectStatus;
          error_message?: string | null;
          claimed_by?: string | null;
          claimed_at?: string | null;
          attempts?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          project_id?: string;
          storage_path?: string | null;
          original_filename?: string;
          source_url?: string | null;
          duration_seconds?: number | null;
          size_bytes?: number | null;
          mime_type?: string | null;
          status?: ProjectStatus;
          error_message?: string | null;
          claimed_by?: string | null;
          claimed_at?: string | null;
          attempts?: number;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };

      transcripts: {
        Row: {
          id: string;
          video_id: string;
          language: string;
          duration_seconds: number;
          full_text: string;
          segments: unknown;
          provider: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          video_id: string;
          language?: string;
          duration_seconds: number;
          full_text: string;
          segments: unknown;
          provider: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          video_id?: string;
          language?: string;
          duration_seconds?: number;
          full_text?: string;
          segments?: unknown;
          provider?: string;
          created_at?: string;
        };
        Relationships: [];
      };

      clips: {
        Row: {
          id: string;
          project_id: string;
          video_id: string;
          start_time: number;
          end_time: number;
          duration: number;
          title: string;
          hook: string;
          reason: string;
          scores: unknown;
          editing_style: string;
          template: string;
          edl: unknown;
          hashtags: unknown;
          caption: string;
          badges: unknown;
          status: ClipStatus;
          output_video_path: string | null;
          thumbnail_path: string | null;
          error_message: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          project_id: string;
          video_id: string;
          start_time: number;
          end_time: number;
          duration: number;
          title: string;
          hook: string;
          reason: string;
          scores: unknown;
          editing_style: string;
          template: string;
          edl: unknown;
          hashtags?: unknown;
          caption?: string;
          badges?: unknown;
          status?: ClipStatus;
          output_video_path?: string | null;
          thumbnail_path?: string | null;
          error_message?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          project_id?: string;
          video_id?: string;
          start_time?: number;
          end_time?: number;
          duration?: number;
          title?: string;
          hook?: string;
          reason?: string;
          scores?: unknown;
          editing_style?: string;
          template?: string;
          edl?: unknown;
          hashtags?: unknown;
          caption?: string;
          badges?: unknown;
          status?: ClipStatus;
          output_video_path?: string | null;
          thumbnail_path?: string | null;
          error_message?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };

      render_jobs: {
        Row: {
          id: string;
          clip_id: string;
          status: RenderJobStatus;
          stage: string | null;
          progress: number;
          attempts: number;
          error_message: string | null;
          claimed_by: string | null;
          claimed_at: string | null;
          started_at: string | null;
          completed_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          clip_id: string;
          status?: RenderJobStatus;
          stage?: string | null;
          progress?: number;
          attempts?: number;
          error_message?: string | null;
          claimed_by?: string | null;
          claimed_at?: string | null;
          started_at?: string | null;
          completed_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          clip_id?: string;
          status?: RenderJobStatus;
          stage?: string | null;
          progress?: number;
          attempts?: number;
          error_message?: string | null;
          claimed_by?: string | null;
          claimed_at?: string | null;
          started_at?: string | null;
          completed_at?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };

      subscriptions: {
        Row: {
          id: string;
          user_id: string;
          plan: Plan;
          status: string;
          current_period_end: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          plan?: Plan;
          status?: string;
          current_period_end?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          plan?: Plan;
          status?: string;
          current_period_end?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };

      youtube_connections: {
        Row: {
          id: string;
          user_id: string;
          access_token: string;
          refresh_token: string;
          expires_at: string;
          channel_id: string;
          channel_title: string;
          scope: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          access_token: string;
          refresh_token: string;
          expires_at: string;
          channel_id: string;
          channel_title: string;
          scope: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          access_token?: string;
          refresh_token?: string;
          expires_at?: string;
          channel_id?: string;
          channel_title?: string;
          scope?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };

      followed_channels: {
        Row: {
          id: string;
          user_id: string;
          channel_id: string;
          channel_title: string;
          uploads_playlist_id: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          channel_id: string;
          channel_title: string;
          uploads_playlist_id: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          channel_id?: string;
          channel_title?: string;
          uploads_playlist_id?: string;
          created_at?: string;
        };
        Relationships: [];
      };

      youtube_publish_jobs: {
        Row: {
          id: string;
          clip_id: string;
          status: YoutubePublishStatus;
          title: string;
          description: string;
          tags: unknown;
          privacy_status: YoutubePrivacyStatus;
          youtube_video_id: string | null;
          youtube_url: string | null;
          error_message: string | null;
          claimed_by: string | null;
          claimed_at: string | null;
          attempts: number;
          started_at: string | null;
          completed_at: string | null;
          created_at: string;
          publish_at: string | null;
          view_count: number | null;
          like_count: number | null;
          comment_count: number | null;
          stats_updated_at: string | null;
        };
        Insert: {
          id?: string;
          clip_id: string;
          status?: YoutubePublishStatus;
          title: string;
          description: string;
          tags?: unknown;
          privacy_status?: YoutubePrivacyStatus;
          youtube_video_id?: string | null;
          youtube_url?: string | null;
          error_message?: string | null;
          claimed_by?: string | null;
          claimed_at?: string | null;
          attempts?: number;
          started_at?: string | null;
          completed_at?: string | null;
          created_at?: string;
          publish_at?: string | null;
          view_count?: number | null;
          like_count?: number | null;
          comment_count?: number | null;
          stats_updated_at?: string | null;
        };
        Update: {
          id?: string;
          clip_id?: string;
          status?: YoutubePublishStatus;
          title?: string;
          description?: string;
          tags?: unknown;
          privacy_status?: YoutubePrivacyStatus;
          youtube_video_id?: string | null;
          youtube_url?: string | null;
          error_message?: string | null;
          claimed_by?: string | null;
          claimed_at?: string | null;
          attempts?: number;
          started_at?: string | null;
          completed_at?: string | null;
          created_at?: string;
          publish_at?: string | null;
          view_count?: number | null;
          like_count?: number | null;
          comment_count?: number | null;
          stats_updated_at?: string | null;
        };
        Relationships: [];
      };

      usage: {
        Row: {
          id: string;
          user_id: string;
          period_start: string;
          period_end: string;
          minutes_processed: number;
          clips_generated: number;
          storage_bytes: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          period_start: string;
          period_end: string;
          minutes_processed?: number;
          clips_generated?: number;
          storage_bytes?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          period_start?: string;
          period_end?: string;
          minutes_processed?: number;
          clips_generated?: number;
          storage_bytes?: number;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
    };

    Views: Record<string, never>;

    Functions: {
      claim_next_video: {
        Args: { p_worker_id: string; p_stale_seconds?: number; p_max_attempts?: number };
        Returns: Database["public"]["Tables"]["videos"]["Row"] | null;
      };
      claim_next_render_job: {
        Args: { p_worker_id: string; p_stale_seconds?: number; p_max_attempts?: number };
        Returns: Database["public"]["Tables"]["render_jobs"]["Row"] | null;
      };
      claim_next_publish_job: {
        Args: { p_worker_id: string; p_stale_seconds?: number; p_max_attempts?: number };
        Returns: Database["public"]["Tables"]["youtube_publish_jobs"]["Row"] | null;
      };
    };
  };
}

// --- Tipi "comodi" con nome, derivati da Database (mai il contrario, vedi commento sopra) ---

export type ProfileRow = Database["public"]["Tables"]["profiles"]["Row"];
export type ProfileInsert = Database["public"]["Tables"]["profiles"]["Insert"];
export type ProfileUpdate = Database["public"]["Tables"]["profiles"]["Update"];

export type ProjectRow = Database["public"]["Tables"]["projects"]["Row"];
export type ProjectInsert = Database["public"]["Tables"]["projects"]["Insert"];
export type ProjectUpdate = Database["public"]["Tables"]["projects"]["Update"];

export type VideoRow = Database["public"]["Tables"]["videos"]["Row"];
export type VideoInsert = Database["public"]["Tables"]["videos"]["Insert"];
export type VideoUpdate = Database["public"]["Tables"]["videos"]["Update"];

export type TranscriptRow = Database["public"]["Tables"]["transcripts"]["Row"];
export type TranscriptInsert = Database["public"]["Tables"]["transcripts"]["Insert"];
export type TranscriptUpdate = Database["public"]["Tables"]["transcripts"]["Update"];

export type ClipRow = Database["public"]["Tables"]["clips"]["Row"];
export type ClipInsert = Database["public"]["Tables"]["clips"]["Insert"];
export type ClipUpdate = Database["public"]["Tables"]["clips"]["Update"];

export type RenderJobRow = Database["public"]["Tables"]["render_jobs"]["Row"];
export type RenderJobInsert = Database["public"]["Tables"]["render_jobs"]["Insert"];
export type RenderJobUpdate = Database["public"]["Tables"]["render_jobs"]["Update"];

export type SubscriptionRow = Database["public"]["Tables"]["subscriptions"]["Row"];
export type SubscriptionInsert = Database["public"]["Tables"]["subscriptions"]["Insert"];
export type SubscriptionUpdate = Database["public"]["Tables"]["subscriptions"]["Update"];

export type UsageRow = Database["public"]["Tables"]["usage"]["Row"];
export type UsageInsert = Database["public"]["Tables"]["usage"]["Insert"];
export type UsageUpdate = Database["public"]["Tables"]["usage"]["Update"];

export type YoutubeConnectionRow = Database["public"]["Tables"]["youtube_connections"]["Row"];
export type YoutubeConnectionInsert = Database["public"]["Tables"]["youtube_connections"]["Insert"];
export type YoutubeConnectionUpdate = Database["public"]["Tables"]["youtube_connections"]["Update"];

export type FollowedChannelRow = Database["public"]["Tables"]["followed_channels"]["Row"];
export type FollowedChannelInsert = Database["public"]["Tables"]["followed_channels"]["Insert"];

export type YoutubePublishJobRow = Database["public"]["Tables"]["youtube_publish_jobs"]["Row"];
export type YoutubePublishJobInsert = Database["public"]["Tables"]["youtube_publish_jobs"]["Insert"];
export type YoutubePublishJobUpdate = Database["public"]["Tables"]["youtube_publish_jobs"]["Update"];

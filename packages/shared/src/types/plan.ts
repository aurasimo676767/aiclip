export const PLANS = ["FREE", "PRO", "BUSINESS"] as const;
export type Plan = (typeof PLANS)[number];

export interface PlanLimits {
  plan: Plan;
  /** Minuti di video sorgente processabili al mese. */
  monthlyProcessingMinutes: number;
  /** Numero massimo di clip renderizzabili al mese. */
  monthlyClips: number;
  /** Storage totale consentito (bytes). */
  storageBytes: number;
  maxUploadSizeBytes: number;
}

/**
 * Limiti dei piani. Fase 1: nessun sistema di pagamento collegato, ma il DB
 * (profiles.plan, profiles.credits) e questi limiti sono già pronti per quando
 * verrà integrato un billing provider (es. Stripe).
 */
export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  FREE: {
    plan: "FREE",
    monthlyProcessingMinutes: 60,
    monthlyClips: 15,
    storageBytes: 5 * 1024 * 1024 * 1024,
    maxUploadSizeBytes: 500 * 1024 * 1024,
  },
  PRO: {
    plan: "PRO",
    monthlyProcessingMinutes: 600,
    monthlyClips: 200,
    storageBytes: 50 * 1024 * 1024 * 1024,
    maxUploadSizeBytes: 2 * 1024 * 1024 * 1024,
  },
  BUSINESS: {
    plan: "BUSINESS",
    monthlyProcessingMinutes: 3000,
    monthlyClips: 1000,
    storageBytes: 250 * 1024 * 1024 * 1024,
    maxUploadSizeBytes: 5 * 1024 * 1024 * 1024,
  },
};

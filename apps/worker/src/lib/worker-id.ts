import os from "node:os";
import crypto from "node:crypto";

/** Identificatore stabile per il processo worker corrente, usato per il claim dei job. */
export const WORKER_ID = `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;

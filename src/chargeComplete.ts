import { ChargerStatus, isCarConnected, isCharging } from './client';
import { CURRENT_LIMIT_MIN_A } from './settings';

/** Consecutive polls the "car stopped drawing" condition must hold. */
const CANDIDATE_POLLS = 2;

/**
 * "Car finished" = the charger is still OFFERING current but the car stopped
 * drawing. When DLM/eco/solar/grid modes pause the session, the charger
 * offers 0 A — indistinguishable from "full" without this guard, and it would
 * fire on every solar lull. Requiring the condition to hold for two polls also
 * rides out brief car-side pauses. A deliberate stop (HomeKit, app, RFID)
 * clears charge_enabled first and never fires.
 *
 * (The CDR's per-period stop reason 11, "vehicle not accepting charge", is
 * not a better signal: live CDRs show it many times within one session,
 * whenever the car pauses.)
 */
export class ChargeCompleteDetector {
  private complete = false;
  private candidatePolls = 0;
  private prevActivelyCharging?: boolean;

  get isComplete(): boolean {
    return this.complete;
  }

  /** Feed one successful poll; returns true on the poll where it fires. */
  update(status: ChargerStatus): boolean {
    const activelyCharging = isCharging(status);
    const carConnected = isCarConnected(status);
    const offered = status.current_offered;
    const candidate = !activelyCharging
      && carConnected
      && status.charge_enabled === true
      && typeof offered === 'number'
      && offered >= CURRENT_LIMIT_MIN_A;
    let fired = false;
    if (candidate && (this.prevActivelyCharging === true || this.candidatePolls > 0)) {
      this.candidatePolls += 1;
      if (this.candidatePolls >= CANDIDATE_POLLS && !this.complete) {
        this.complete = true;
        fired = true;
      }
    } else if (!candidate) {
      this.candidatePolls = 0;
    }
    if (activelyCharging || !carConnected) {
      this.complete = false;
      this.candidatePolls = 0;
    }
    this.prevActivelyCharging = activelyCharging;
    return fired;
  }
}

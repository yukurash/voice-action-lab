export class MaintenanceDrainingError extends Error {
  readonly code = "MAINTENANCE_DRAINING";

  constructor() {
    super("New sessions are blocked during deployment maintenance.");
    this.name = "MaintenanceDrainingError";
  }
}

/** Share this instance with the listener; assert immediately before atomic reservation, without an await. */
export class MaintenanceGate {
  #draining = false;

  get isDraining(): boolean {
    return this.#draining;
  }

  assertAccepting(): void {
    if (this.#draining) throw new MaintenanceDrainingError();
  }

  beginDrain(): void {
    this.#draining = true;
  }

  resume(): void {
    this.#draining = false;
  }
}

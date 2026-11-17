/** A session graph shares one capacity; each child registry owns its leases. */
export class RequestContextBudget {
  private count = 0;
  public constructor(private readonly limit: number) {}
  public get size(): number { return this.count; }

  public acquire(): () => void {
    if (this.count >= this.limit) throw new Error(`Request context limit exceeded: Lumen Script supports at most ${String(this.limit)} unique request contexts`);
    this.count += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.count -= 1;
    };
  }
}

/** Single writer for session state, including suspended paginated evaluations. */
export class SessionOperations {
  private active: symbol | undefined;
  private name: string | undefined;

  public assertIdle(): void {
    if (this.active !== undefined) throw new Error(`Engine session is busy with ${this.name}`);
  }

  public begin(name: string): () => void {
    this.assertIdle();
    const token = Symbol(name);
    this.active = token;
    this.name = name;
    return () => {
      if (this.active !== token) return;
      this.active = undefined;
      this.name = undefined;
    };
  }
}

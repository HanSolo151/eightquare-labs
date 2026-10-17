declare module "stockfish" {
  interface StockfishEngine {
    processCommand(command: string): void;
    terminate(): void;
  }

  function createStockfishEngine(
    variant: string,
    onLine: (line: string) => void
  ): StockfishEngine;

  export default createStockfishEngine;
}

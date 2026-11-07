export function assertHttpContract(
  route: string,
  method: string,
  status: number,
  body: unknown,
): void;
export function assertRequestContract(
  route: string,
  method: string,
  body: unknown,
  expected: boolean,
): void;
export function assertImplementedDeclarations(): void;
export function assertR04PublicAuthContract(document?: unknown): void;

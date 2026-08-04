// Type surface of generate-idotmatrix-identity.mjs for the vitest sync test.
export interface IDotMatrixIdentitySpec {
  serviceUuid: string;
  writeCharacteristicUuid: string;
  namePrefixes: string[];
}

export declare function emitSwift(identity: IDotMatrixIdentitySpec): string;
export declare function emitPython(identity: IDotMatrixIdentitySpec): string;
export declare const OUTPUTS: ReadonlyArray<
  readonly [string, (identity: IDotMatrixIdentitySpec) => string]
>;

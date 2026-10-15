import { canonicalJsonHash } from "../../funding/persistence/canonical.js";

/** Public transaction identity, not an authorization token or request ID.
 * Frozen operation/segment network, asset and recipient still have to match.
 * This positive-only commitment survives lookup-HMAC rotation. It must never
 * contain origin references or be interpreted as a complete negative manifest.
 */
export function relayDestinationReferenceIdentity(reference: string): string {
  const value = reference.trim();
  if (!value || value.length > 256)
    throw new Error("relay_destination_reference_invalid");
  return canonicalJsonHash({
    domain: "hunch:relay:successful-destination-reference:v1",
    reference: /^0x[0-9a-f]{64}$/iu.test(value) ? value.toLowerCase() : value,
  });
}

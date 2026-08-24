/**
 * Protocol package boundary.
 *
 * The adapter deliberately parses envelopes as unknown data so additive fields
 * cannot break the observatory. The generated source tree remains adjacent for
 * inspection and regeneration, while this value records the reviewed contract.
 */
export const PROTOCOL_GENERATION_VERSION = "0.149.0" as const;

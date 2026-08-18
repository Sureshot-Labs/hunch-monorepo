export type ContentActor =
  | { kind: "admin"; id: string; label: string }
  | { kind: "service"; id: string; label: string }
  | { kind: "system"; id: null; label: string };

export type ContentActorInput = ContentActor | string | null;

function actorLabel(
  label: string | null | undefined,
  fallback: string,
): string {
  return (label?.trim() || fallback).slice(0, 200);
}

export function adminContentActor(
  id: string,
  label?: string | null,
): ContentActor {
  return { kind: "admin", id, label: actorLabel(label, `admin:${id}`) };
}

export function serviceContentActor(id: string, label: string): ContentActor {
  return { kind: "service", id, label: actorLabel(label, `service:${id}`) };
}

export function normalizeContentActor(input: ContentActorInput): ContentActor {
  if (typeof input === "string") return adminContentActor(input);
  if (!input) return { kind: "system", id: null, label: "system" };
  return {
    ...input,
    label: actorLabel(
      input.label,
      input.kind === "system" ? "system" : `${input.kind}:${input.id}`,
    ),
  };
}

export function contentActorAdminId(actor: ContentActor): string | null {
  return actor.kind === "admin" ? actor.id : null;
}

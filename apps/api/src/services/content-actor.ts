export type AdminContentActor = {
  kind: "admin";
  id: string;
  label: string;
};

export type ServiceContentActor = {
  kind: "service";
  id: string;
  label: string;
};

export type SystemContentActor = {
  kind: "system";
  id: null;
  label: string;
};

export type ContentActor =
  | AdminContentActor
  | ServiceContentActor
  | SystemContentActor;

export type ContentActorInput = ContentActor | string | null;

export function adminContentActor(
  id: string,
  label?: string | null,
): AdminContentActor {
  return {
    kind: "admin",
    id,
    label: label?.trim() || `admin:${id}`,
  };
}

export function serviceContentActor(
  id: string,
  label: string,
): ServiceContentActor {
  return { kind: "service", id, label: label.trim() || `service:${id}` };
}

export function systemContentActor(label: string): SystemContentActor {
  return { kind: "system", id: null, label: label.trim() || "system" };
}

export function normalizeContentActor(input: ContentActorInput): ContentActor {
  if (typeof input === "string") return adminContentActor(input);
  return input ?? systemContentActor("legacy-system");
}

export function contentActorAdminId(actor: ContentActor): string | null {
  return actor.kind === "admin" ? actor.id : null;
}

export function contentActorServicePrincipalId(
  actor: ContentActor,
): string | null {
  return actor.kind === "service" ? actor.id : null;
}

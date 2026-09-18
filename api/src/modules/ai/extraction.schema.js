import { z } from "zod";

const confidence = z.number().min(0).max(1);

export const extractionSchema = z.object({
  relevance: z.enum(["OUTAGE", "PLANNED_OUTAGE", "RESTORATION", "UPDATE", "GENERAL_NOTICE", "IRRELEVANT"]),
  summary: z.string().nullable().optional(),
  eventType: z.string().nullable().optional(),
  reportedStatus: z.string().nullable().optional(),
  affectedAreas: z.array(z.object({ name: z.string(), evidence: z.enum(["TEXT", "OCR"]), confidence })).default([]),
  infrastructure: z.array(z.object({ name: z.string(), type: z.string(), evidence: z.enum(["TEXT", "OCR"]), confidence })).default([]),
  infrastructureRelationships: z.array(z.object({ fromName: z.string(), relationshipType: z.string(), toName: z.string(), toEntityType: z.enum(["INFRASTRUCTURE", "LOCALITY"]), evidenceText: z.string(), evidence: z.enum(["TEXT", "OCR"]), confidence, explicitlySupportedByCurrentPost: z.boolean() })).default([]),
  aliasObservations: z.array(z.object({ observedName: z.string(), canonicalCandidateName: z.string().nullable().optional(), confidence, explicitlySupportedByCurrentPost: z.boolean() })).default([]),
  cause: z.object({ text: z.string().nullable(), confidence }).nullable().optional(),
  eta: z.object({ text: z.string().nullable(), parsedAt: z.string().nullable().optional(), confidence }).nullable().optional(),
  restoration: z.object({ isRestored: z.boolean(), restoredAreas: z.array(z.string()).default([]), stillAffectedAreas: z.array(z.string()).default([]) }).default({ isRestored: false, restoredAreas: [], stillAffectedAreas: [] }),
  referenceNumbers: z.array(z.string()).default([]),
  recommendedAssociation: z.object({ action: z.enum(["CREATE", "LINK", "NONE"]), incidentId: z.string().nullable().optional(), confidence, reason: z.string() }).nullable().optional(),
});

export const extractionSchemaJson = {
  type: "object",
  required: ["relevance", "summary", "eventType", "reportedStatus", "affectedAreas", "infrastructure", "infrastructureRelationships", "aliasObservations", "cause", "eta", "restoration", "referenceNumbers", "recommendedAssociation"],
  properties: {
    relevance: { type: "string", enum: ["OUTAGE", "PLANNED_OUTAGE", "RESTORATION", "UPDATE", "GENERAL_NOTICE", "IRRELEVANT"] },
    summary: { type: ["string", "null"] }, eventType: { type: ["string", "null"] }, reportedStatus: { type: ["string", "null"] },
    affectedAreas: { type: "array", items: { type: "object", required: ["name", "evidence", "confidence"], properties: { name: { type: "string" }, evidence: { type: "string", enum: ["TEXT", "OCR"] }, confidence: { type: "number" } } } },
    infrastructure: { type: "array", items: { type: "object", required: ["name", "type", "evidence", "confidence"], properties: { name: { type: "string" }, type: { type: "string" }, evidence: { type: "string", enum: ["TEXT", "OCR"] }, confidence: { type: "number" } } } },
    infrastructureRelationships: { type: "array", items: { type: "object", required: ["fromName", "relationshipType", "toName", "toEntityType", "evidenceText", "evidence", "confidence", "explicitlySupportedByCurrentPost"], properties: { fromName: { type: "string" }, relationshipType: { type: "string" }, toName: { type: "string" }, toEntityType: { type: "string", enum: ["INFRASTRUCTURE", "LOCALITY"] }, evidenceText: { type: "string" }, evidence: { type: "string", enum: ["TEXT", "OCR"] }, confidence: { type: "number" }, explicitlySupportedByCurrentPost: { type: "boolean" } } } },
    aliasObservations: { type: "array", items: { type: "object", required: ["observedName", "canonicalCandidateName", "confidence", "explicitlySupportedByCurrentPost"], properties: { observedName: { type: "string" }, canonicalCandidateName: { type: ["string", "null"] }, confidence: { type: "number" }, explicitlySupportedByCurrentPost: { type: "boolean" } } } },
    cause: { type: ["object", "null"], required: ["text", "confidence"], properties: { text: { type: ["string", "null"] }, confidence: { type: "number" } } },
    eta: { type: ["object", "null"], required: ["text", "confidence"], properties: { text: { type: ["string", "null"] }, parsedAt: { type: ["string", "null"] }, confidence: { type: "number" } } },
    restoration: { type: "object", required: ["isRestored", "restoredAreas", "stillAffectedAreas"], properties: { isRestored: { type: "boolean" }, restoredAreas: { type: "array", items: { type: "string" } }, stillAffectedAreas: { type: "array", items: { type: "string" } } } },
    referenceNumbers: { type: "array", items: { type: "string" } },
    recommendedAssociation: { type: ["object", "null"], required: ["action", "incidentId", "confidence", "reason"], properties: { action: { type: "string", enum: ["CREATE", "LINK", "NONE"] }, incidentId: { type: ["string", "null"] }, confidence: { type: "number" }, reason: { type: "string" } } },
  },
};

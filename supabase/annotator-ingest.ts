import { serve } from "https://deno.land/std@0.200.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SB_URL");
const serviceRoleKey = Deno.env.get("SB_SERVICE_ROLE");
const bucketName = Deno.env.get("SB_BUCKET") ?? "annotations";
const sharedSecret = Deno.env.get("SHARED_SECRET") ?? "";
const allowOrigin = Deno.env.get("ALLOW_ORIGIN");

if (!supabaseUrl) {
  throw new Error("SB_URL is required");
}

if (!serviceRoleKey) {
  throw new Error("SB_SERVICE_ROLE is required");
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "OPTIONS, POST",
  };
}

function badRequest(message: string, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
    },
  });
}

function normalizeFilename(input: string | null | undefined, fallback: string) {
  const raw = (input ?? "").trim();
  const safe = raw.replace(/[^a-z0-9_.-]+/gi, "-").replace(/-+/g, "-");
  return safe || fallback;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders() });
  }

  if (req.method !== "POST") {
    return badRequest("Method not allowed", 405);
  }

  if (sharedSecret) {
    const incoming = req.headers.get("authorization") ?? "";
    const token = incoming.replace(/^Bearer\s+/i, "").trim();
    if (token !== sharedSecret) {
      return badRequest("Unauthorized", 401);
    }
  }

  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return badRequest("Expected application/json body");
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch (error) {
    console.error("Unable to parse JSON", error);
    return badRequest("Invalid JSON payload");
  }

  const annotation = body.annotation as Record<string, unknown> | undefined;
  const participantId = (body.participantId ?? body.studyId ?? annotation?.participantId ?? "") as string;
  const clipId = (annotation?.clipId ?? "clip") as string;
  const filenameHint = (body.filenameHint ?? annotation?.filenameHint ?? "") as string;

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeParticipant = normalizeFilename(participantId, "participant-unknown");
  const safeClip = normalizeFilename(clipId, "clip");
  const safeFilename = normalizeFilename(filenameHint, `${safeParticipant}_${safeClip}.json`);

  const objectPath = `${safeParticipant}/${timestamp}_${safeFilename}`;

  const payloadString = JSON.stringify(body, null, 2);
  const upload = await supabase.storage
    .from(bucketName)
    .upload(objectPath, new Blob([payloadString], { type: "application/json" }), {
      contentType: "application/json",
      upsert: false,
    });

  if (upload.error) {
    console.error("Supabase upload error", upload.error);
    return badRequest(`Failed to store annotation: ${upload.error.message}`, 500);
  }

  return new Response(
    JSON.stringify({ storedAt: objectPath }),
    {
      status: 201,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders(),
      },
    },
  );
});

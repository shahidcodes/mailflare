import { parseEmailAddressParts } from "@/lib/email/address";
import type { OutboundProviderMessage } from "@/lib/email/outbound-provider-types";

const BREVO_API = "https://api.brevo.com/v3";

type BrevoEnv = { BREVO_API_KEY?: string; BREVO_API_KEYS?: string };

/**
 * The Brevo API key for a sending domain. BREVO_API_KEYS is an optional JSON map of
 * hostname to key, for domains that live in different Brevo accounts; BREVO_API_KEY
 * is the key for every other domain. Both are Worker secrets.
 */
export function getBrevoApiKey(env: CloudflareEnv, hostname: string): string | null {
	const vars = env as unknown as BrevoEnv;
	if (vars.BREVO_API_KEYS) {
		try {
			const map = JSON.parse(vars.BREVO_API_KEYS) as Record<string, string>;
			const key = map[hostname.toLowerCase()]?.trim();
			if (key) return key;
		} catch {
			// A malformed map falls back to the shared key.
		}
	}
	return vars.BREVO_API_KEY?.trim() || null;
}

export function requireBrevoApiKey(env: CloudflareEnv, hostname: string): string {
	const key = getBrevoApiKey(env, hostname);
	if (!key) throw new Error(`Brevo is selected for ${hostname} but no BREVO_API_KEY secret is set`);
	return key;
}

function toBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	}
	return btoa(binary);
}

const recipients = (list: string[] | undefined) =>
	list?.map((value) => {
		const { name, address } = parseEmailAddressParts(value);
		return name ? { email: address, name } : { email: address };
	});

/** The JSON body for POST /v3/smtp/email. Brevo assigns the Message-ID, so a caller's one is dropped. */
export function brevoPayload(message: OutboundProviderMessage) {
	const sender = parseEmailAddressParts(message.from);
	const headers = Object.fromEntries(Object.entries(message.headers ?? {}).filter(([name]) => name.toLowerCase() !== "message-id"));
	return {
		sender: sender.name ? { email: sender.address, name: sender.name } : { email: sender.address },
		to: recipients(message.to),
		...(message.cc?.length ? { cc: recipients(message.cc) } : {}),
		...(message.bcc?.length ? { bcc: recipients(message.bcc) } : {}),
		subject: message.subject,
		...(message.html ? { htmlContent: message.html } : {}),
		...(message.text ? { textContent: message.text } : {}),
		...(Object.keys(headers).length ? { headers } : {}),
		...(message.attachments?.length
			? { attachment: message.attachments.map((attachment) => ({ name: attachment.filename, content: toBase64(attachment.content) })) }
			: {}),
	};
}

/** Sends through the Brevo transactional API. Replies thread on the Message-ID Brevo returns. */
export async function sendBrevoEmail(apiKey: string, message: OutboundProviderMessage): Promise<{ messageId: string }> {
	const response = await fetch(`${BREVO_API}/smtp/email`, {
		method: "POST",
		headers: { "api-key": apiKey, "content-type": "application/json", accept: "application/json" },
		body: JSON.stringify(brevoPayload(message)),
	});
	const body = (await response.json().catch(() => null)) as { messageId?: string; message?: string } | null;
	if (!response.ok || !body?.messageId) throw new Error(`Brevo: ${body?.message ?? `request failed (${response.status})`}`);
	return { messageId: body.messageId };
}

/**
 * Whether the domain is authenticated in Brevo: "verified", "pending" (added but not
 * authenticated), "not_registered", or null when the key cannot read domains (for
 * example a key restricted to transactional email).
 */
export async function getBrevoDomainStatus(env: CloudflareEnv, hostname: string): Promise<"verified" | "pending" | "not_registered" | "no_key" | null> {
	const apiKey = getBrevoApiKey(env, hostname);
	if (!apiKey) return "no_key";
	try {
		const response = await fetch(`${BREVO_API}/senders/domains/${encodeURIComponent(hostname)}`, { headers: { "api-key": apiKey, accept: "application/json" } });
		if (response.status === 404) return "not_registered";
		if (!response.ok) return null;
		const body = (await response.json()) as { authenticated?: boolean; verified?: boolean };
		return body.authenticated ? "verified" : "pending";
	} catch {
		return null;
	}
}

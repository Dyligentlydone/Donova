// HelcimPay.js Backend Integration for Donova Cloud Subscriptions

export interface HelcimInitParams {
  amount?: number;
  currency?: string;
  email?: string;
  customerName?: string;
  invoiceNumber?: string;
}

export interface HelcimInitResponse {
  checkoutToken: string;
  secretToken: string;
}

const HELCIM_API_URL = "https://api.helcim.com/v2";

export function getHelcimToken(): string {
  const token = process.env.HELCIM_API_TOKEN;
  if (!token) {
    throw new Error("HELCIM_API_TOKEN is not configured in environment");
  }
  return token;
}

export async function initializeHelcimCheckout(params: HelcimInitParams = {}): Promise<HelcimInitResponse> {
  const apiToken = getHelcimToken();
  const amount = params.amount ?? 11.0;
  const currency = params.currency ?? "USD";
  const invoiceNumber = params.invoiceNumber ?? `DNV-SUB-${Date.now().toString(36).toUpperCase()}`;

  const body: Record<string, unknown> = {
    paymentType: "purchase",
    amount,
    currency,
    invoiceNumber,
  };

  if (params.email || params.customerName) {
    body.customerRequest = {
      contactName: params.customerName || "Creator",
      email: params.email || "",
    };
  }

  const res = await fetch(`${HELCIM_API_URL}/helcim-pay/initialize`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "api-token": apiToken,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error("Helcim initialize error:", res.status, errText);
    throw new Error(`Helcim checkout initialization failed (${res.status}): ${errText}`);
  }

  const data = (await res.json()) as HelcimInitResponse;
  if (!data.checkoutToken) {
    throw new Error("Helcim response did not contain checkoutToken");
  }

  return data;
}

/**
 * Server-side proof a checkoutToken represents a real, successful payment —
 * /api/billing/confirm must never grant access on the client's word alone.
 * Returns false for unknown tokens, failed/voided payments, and any Helcim
 * error (fail closed).
 */
export async function verifyHelcimCheckout(checkoutToken: string): Promise<boolean> {
  let apiToken: string;
  try {
    apiToken = getHelcimToken();
  } catch {
    return false; // no API token configured → cannot verify → deny
  }
  try {
    const res = await fetch(
      `${HELCIM_API_URL}/helcim-pay/initialize/${encodeURIComponent(checkoutToken)}`,
      { headers: { accept: "application/json", "api-token": apiToken } },
    );
    if (!res.ok) return false;
    const data = (await res.json()) as {
      status?: string;
      amount?: number;
      payment?: { status?: string };
    };
    const status = String(data.payment?.status ?? data.status ?? "").toLowerCase();
    return ["approved", "captured", "success", "completed", "processed"].includes(status);
  } catch {
    return false;
  }
}

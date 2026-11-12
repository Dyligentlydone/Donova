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

export async function initializeHelcimCheckout(
  params: HelcimInitParams = {},
): Promise<HelcimInitResponse> {
  const apiToken = getHelcimToken();
  const amount = params.amount ?? 11.0;
  const currency = params.currency ?? "USD";
  const invoiceNumber =
    params.invoiceNumber ?? `DNV-SUB-${Date.now().toString(36).toUpperCase()}`;

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

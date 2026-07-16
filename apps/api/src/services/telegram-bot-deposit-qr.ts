import QRCode from "qrcode";

const EVM_ADDRESS_RE = /^0x[0-9a-f]{40}$/i;

export async function generateTelegramDepositQr(
  address: string,
): Promise<Buffer> {
  const normalized = address.trim();
  if (!EVM_ADDRESS_RE.test(normalized)) {
    throw new Error("Deposit QR requires a valid EVM address.");
  }
  const png = await QRCode.toBuffer(normalized, {
    color: { dark: "#101D2B", light: "#FFFFFF" },
    errorCorrectionLevel: "H",
    margin: 4,
    type: "png",
    width: 640,
  });
  if (
    png.length < 8 ||
    png[0] !== 0x89 ||
    png.subarray(1, 4).toString("ascii") !== "PNG"
  ) {
    throw new Error("Deposit QR generation returned an invalid PNG.");
  }
  return png;
}

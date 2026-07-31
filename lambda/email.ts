import { SendEmailCommand, type SESv2Client } from '@aws-sdk/client-sesv2';
import { licenseTerms, licenseTier, parseSku } from '../src/lib/downloads';
import type { Fulfillment } from './fulfill';

/**
 * The buyer's durable copy of the link and the license, which is why the
 * license text is repeated in full rather than linked.
 */

export interface EmailDeps {
  ses: SESv2Client;
  fromEmail: string;
}

export function deliveryEmail(fulfillment: Fulfillment): { subject: string; text: string } {
  const { item, downloadUrl, expiresAt } = fulfillment;
  if (!item || !downloadUrl || !expiresAt) {
    throw new Error('Cannot compose a delivery email for an unfulfilled purchase');
  }
  const tier = licenseTier(parseSku(item.sku).license);
  const expires = new Date(expiresAt * 1000).toLocaleDateString('en-US', {
    dateStyle: 'long',
    timeZone: 'UTC',
  });
  /* Dimensions come from the catalog, which a delisted photo has left. */
  const size = item.dimensions
    ? ` (${item.dimensions.width} × ${item.dimensions.height} pixels)`
    : '';

  return {
    subject: `Your download — ${item.albumTitle}`,
    text: [
      `Thank you. Your full-resolution file is ready:`,
      '',
      downloadUrl,
      '',
      `${item.albumTitle} — ${item.file}${size}`,
      `This link works until ${expires}. Download it somewhere you keep things.`,
      '',
      'Your license',
      tier ? licenseTerms(tier) : '',
      '',
      'Reply to this email if anything goes wrong and I will sort it out.',
      '',
      'Adam Ficke',
      'https://adamficke.com',
    ].join('\n'),
  };
}

export async function sendDelivery(
  fulfillment: Fulfillment,
  { ses, fromEmail }: EmailDeps,
): Promise<void> {
  if (!fulfillment.email) {
    /* Checkout collects an email by default, so this means something changed. */
    throw new Error('Fulfilled purchase has no email address to deliver to');
  }
  const { subject, text } = deliveryEmail(fulfillment);
  await ses.send(new SendEmailCommand({
    FromEmailAddress: fromEmail,
    Destination: { ToAddresses: [fulfillment.email] },
    Content: { Simple: { Subject: { Data: subject }, Body: { Text: { Data: text } } } },
  }));
}

/**
 * Site-wide switches and contact details.
 *
 * COMING_SOON: while photos are still being shot/edited, the home page shows
 * the "photos coming soon" landing page (couple photo + WhatsApp inquiry)
 * instead of the gallery finder. Set to false to bring the finder back.
 * Wedding gallery links (/w/<slug>, printed QR short links) show the same
 * landing page automatically until that gallery is live with guest access.
 */
export const COMING_SOON = true;

export const CONTACT = {
  phoneDisplay: '+91 92000 10123',
  phoneTel: '+919200010123',
  whatsapp: '919200010123',
  whatsappText: 'Hi Jab We Wed, I would like to enquire about a shoot.',
  instagram: 'jabwewed.in',
};

/** Couple photo shown on the coming-soon page (file in /public). */
export const COUPLE_PHOTO = '/couple/couple.jpg';

/**
 * Guest downloads get the premium "Jab We Wed" frame (ivory mount, keyline,
 * couple names, brand signature). Set to false to deliver plain originals.
 */
export const FRAME_DOWNLOADS = true;

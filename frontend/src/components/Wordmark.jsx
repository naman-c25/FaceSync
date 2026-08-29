/**
 * The FaceSync mark, shared by every screen.
 *
 * It exists because there were two: the landing page carried a drawn logo
 * while the kiosk, the till, the portal and the fraud desk each carried a
 * green dot. Clicking through from one to the other read as leaving the
 * product, which is the opposite of what a mark is for.
 *
 * The glyph itself carries both halves of the name — scan brackets for the
 * face, an open ring for the sync, and an iris where the two meet.
 *
 * @param {string} [suffix]  which surface this is, shown quietly after the name
 * @param {boolean} [large]  the landing's size; every other screen uses the small one
 */
export function Wordmark({ suffix, large = false, href }) {
  const inner = (
    <>
      <span className="mark-glyph">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M2.5 8.2V5.6A3.1 3.1 0 0 1 5.6 2.5h2.6" />
          <path d="M15.8 2.5h2.6a3.1 3.1 0 0 1 3.1 3.1v2.6" />
          <path d="M21.5 15.8v2.6a3.1 3.1 0 0 1-3.1 3.1h-2.6" />
          <path d="M8.2 21.5H5.6a3.1 3.1 0 0 1-3.1-3.1v-2.6" />
          <path d="M17 12a5 5 0 1 0-2.3 4.2" strokeWidth="1.7" />
          <circle cx="12" cy="12" r="1.9" fill="currentColor" stroke="none" />
        </svg>
      </span>
      <span className="mark-text">
        FaceSync
        {suffix && <em>{suffix}</em>}
      </span>
    </>
  );

  const className = `mark${large ? ' mark-lg' : ''}`;

  // A link on the landing, where there is somewhere to go back to; plain text
  // on the kiosk and the till, where it would only interrupt a payment.
  return href ? (
    <a className={className} href={href}>
      {inner}
    </a>
  ) : (
    <span className={className}>{inner}</span>
  );
}

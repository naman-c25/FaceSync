/**
 * One row of a settings list: what it is, where it stands, and whether it can
 * be changed yet.
 *
 * The unbuilt ones read "Not linked" rather than showing a plausible account
 * number or a limit nobody enforces. A screen in a payment app that displays a
 * figure the system does not honour is not a placeholder, it is a false
 * statement — and these are exactly the screens where somebody would believe
 * it. The `Soon` chip says which is which without anyone having to guess.
 *
 * @param {string} label   the setting
 * @param {string} [note]  one line on what it governs
 * @param {string} value   its current state
 * @param {boolean} [soon] true when nothing behind it is wired up yet
 */
export function SettingRow({ label, note, value, soon = false }) {
  return (
    <div className="setting">
      <div>
        <strong>{label}</strong>
        {note && <span>{note}</span>}
      </div>
      <div className="setting-value">
        <span className={soon ? 'unset' : ''}>{value}</span>
        {soon && <em className="soon">Soon</em>}
      </div>
    </div>
  );
}

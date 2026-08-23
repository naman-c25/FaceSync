/**
 * A receipt the shopkeeper can hand over, print, or let the customer photograph.
 *
 * The customer walked up with nothing and left with nothing, which is the whole
 * point of the system and also the one thing that makes it feel unfinished at
 * the counter: there is no card slip, no app notification, nothing they can
 * point at later. This is that.
 *
 * Deliberately not on it:
 *
 *   The match score. It is the right number for tuning a threshold and the
 *   wrong one to hand a customer, who has no way to read "0.87" except as a
 *   statement about how sure the shop is that they are themselves.
 *
 *   Any identifier. No phone number, no email, no account number, because the
 *   system holds none — a receipt is exactly where one would quietly reappear.
 *   The customer's name is on it because they were greeted by it at the till
 *   and it is what makes the slip theirs.
 */
export function Receipt({ merchant, payment, onDone }) {
  const when = new Date(payment.at ?? Date.now());

  return (
    <div className="screen">
      {/* The printable region. Everything outside it is hidden when printing,
          so a till with a roll printer produces the slip and nothing else. */}
      <div className="receipt" id="receipt">
        <div className="receipt-head">
          <strong>{merchant.name}</strong>
          <span className="muted">Paid by face</span>
        </div>

        <div className="receipt-amount">₹{payment.amount}</div>

        <dl className="receipt-lines">
          <div>
            <dt>Customer</dt>
            <dd>{payment.customer}</dd>
          </div>
          <div>
            <dt>Date</dt>
            <dd>
              {when.toLocaleString(undefined, {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </dd>
          </div>
          <div>
            <dt>Verified by</dt>
            {/* Recorded per payment rather than assumed, so the slip says what
                actually happened rather than what the flow usually does. */}
            <dd>{(payment.authFactors ?? []).join(' + ') || 'face'}</dd>
          </div>
          <div>
            <dt>Reference</dt>
            <dd className="mono">{payment.transactionId ?? payment.id}</dd>
          </div>
          {payment.orderId && (
            <div>
              <dt>Order</dt>
              <dd className="mono">{payment.orderId}</dd>
            </div>
          )}
        </dl>

        <p className="receipt-foot">
          No card and no phone was presented. This is a prototype built for the
          Razorpay hackathon and is not proof of a settled payment.
        </p>
      </div>

      <div className="stack no-print">
        <button className="btn btn-primary" onClick={() => window.print()}>
          Print receipt
        </button>
        <button className="btn btn-ghost" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}

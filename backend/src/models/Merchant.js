import mongoose from 'mongoose';

/**
 * A shop and its terminal login.
 *
 * Merchants may sign up, but signing up is not the same as being trusted with
 * a terminal. `role` lives here, in the database, and is never derived from
 * anything the account holder chooses — an email that happens to end in
 * "@merchant.com" is a string a user picked, not an authorisation, and reading
 * it as one would let anyone who can type that address grant themselves a
 * terminal.
 *
 * What a terminal actually confers is worth naming, because it is not mainly
 * about money: charging still needs the customer's own PIN, so a hostile shop
 * cannot take anything. What it can do is point a camera at somebody and be
 * told their name. That makes an unapproved terminal a privacy surface rather
 * than a payment one, which is why `verified` gates the camera and not the
 * login.
 */
const merchantSchema = new mongoose.Schema(
  {
    merchantId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    name: { type: String, required: true, trim: true, maxlength: 120 },

    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },

    // scrypt, with a per-record salt. Stored as "salt:hash" hex. Never
    // selected by default, so a stray query cannot return it.
    passwordHash: { type: String, required: true, select: false },

    role: {
      type: String,
      // One role in practice. `admin` belonged to a review screen that no
      // longer exists; the value stays in the enum only so an account created
      // for it still loads rather than failing validation.
      enum: ['merchant', 'admin'],
      default: 'merchant',
      required: true,
    },

    region: { type: String, default: null },
    active: { type: Boolean, default: true },

    // Whether this shop may point a camera at a customer.
    //
    // Defaults to true so that every account created before this existed —
    // and every account made from the command line, which is already an
    // administrative act — keeps working untouched. Self-registration is the
    // only path that sets it false, and it does so explicitly.
    verified: { type: Boolean, default: true },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        delete ret.passwordHash;
        delete ret.__v;
        return ret;
      },
    },
  },
);

export const Merchant = mongoose.model('Merchant', merchantSchema);

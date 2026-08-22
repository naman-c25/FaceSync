import mongoose from 'mongoose';

/**
 * A shop and its terminal login.
 *
 * Merchants do not self-register. `role` lives here, in the database, and is
 * never derived from anything the account holder chooses — an email that
 * happens to contain "@merchant" is a string a user picked, not an
 * authorisation, and treating it as one would let anyone who can register that
 * address grant themselves a merchant terminal.
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
      enum: ['merchant'],
      default: 'merchant',
      required: true,
    },

    region: { type: String, default: null },
    active: { type: Boolean, default: true },
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

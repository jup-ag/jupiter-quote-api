// https://github.com/solana-labs/solana-program-library/blob/29d316e8111543cce288bc5080a54e6953af794c/token/js/src/instructions/transfer.ts
import { u64 } from '@solana/buffer-layout-utils';
import { ASSOCIATED_TOKEN_PROGRAM_ID, Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { AccountMeta, PublicKey, Signer, TransactionInstruction } from '@solana/web3.js';
import BN from 'bn.js';
import { struct, u8 } from '@solana/buffer-layout';

type CreatePaymentInstructionArgs = {
  userPublicKey: PublicKey;
  destinationWallet: PublicKey;
  outputMint: PublicKey;
  paymentAmount: BN;
};

export enum TokenInstruction {
  Transfer = 3,
}

interface TransferInstructionData {
  instruction: TokenInstruction.Transfer;
  amount: bigint;
}

export const transferInstructionData = struct<TransferInstructionData>([u8('instruction'), u64('amount')]);

function createTransferInstruction(
  source: PublicKey,
  destination: PublicKey,
  owner: PublicKey,
  amount: number | bigint,
  programId = TOKEN_PROGRAM_ID,
): TransactionInstruction {
  const keys = [
    { pubkey: source, isSigner: false, isWritable: true },
    { pubkey: destination, isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: true, isWritable: false },
  ];

  const data = Buffer.alloc(transferInstructionData.span);
  transferInstructionData.encode(
    {
      instruction: TokenInstruction.Transfer,
      amount: BigInt(amount),
    },
    data,
  );

  return new TransactionInstruction({ keys, programId, data });
}

export async function createPaymentInstruction({
  userPublicKey,
  destinationWallet,
  outputMint,
  paymentAmount,
}: CreatePaymentInstructionArgs) {
  const userDestinationTokenAccount = await Token.getAssociatedTokenAddress(
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    outputMint,
    userPublicKey,
  );
  const destinationWalletTokenAccount = await Token.getAssociatedTokenAddress(
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    outputMint,
    destinationWallet,
    // @ts-ignore
    true,
  );

  return createTransferInstruction(
    userDestinationTokenAccount,
    destinationWalletTokenAccount,
    userPublicKey,
    BigInt(paymentAmount.toString()),
  );
}

// Confidence is optional and display-only (D5): there is no threshold and no warning. It is hidden for native
// Axon blocks and when the agent gave none; 0 is how failed steps used to be stored, not a real score.
export function showConfidence(confidence: number | undefined | null, runtime: string | undefined): confidence is number {
  return typeof confidence === 'number' && confidence > 0 && runtime !== 'Axon'
}

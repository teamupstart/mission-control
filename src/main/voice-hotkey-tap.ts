/** Bind a stop to the job visible at key-up so a delayed tap cannot stop the next question. */
export function hotkeySpeechJob(state: {speech?: {job: {id: string; state: string} | null}}) {
  const job = state.speech?.job;
  return job && ["preparing", "ready", "speaking", "stopping"].includes(job.state) ? job.id : null;
}

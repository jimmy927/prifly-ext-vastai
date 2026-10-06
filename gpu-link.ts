/**
 * PassMark's page for a GPU, by Vast's `gpu_name`. Names and ids are read off
 * videocardbenchmark.net's `high_end_gpus.html` (2026-10-06). Datacenter
 * parts (A100, H100, H200) have no entry there that Vast's names map to
 * without guessing, so they stay unlinked, like any name not listed.
 */

const SITE = "https://www.videocardbenchmark.net/gpu.php?gpu=";

const PAGES: Readonly<Record<string, string>> = {
  "RTX PRO 6000 S": "RTX+PRO+6000+Blackwell+Server+Edition&id=6962",
  "RTX PRO 6000 WS": "RTX+PRO+6000+Blackwell+Workstation+Edition&id=6307",
  "RTX 5090": "GeForce+RTX+5090&id=5725",
  "RTX 5080": "GeForce+RTX+5080&id=5721",
  "RTX 5070 Ti": "GeForce+RTX+5070+Ti&id=5878",
  "RTX 5070": "GeForce+RTX+5070&id=5940",
  "RTX 4090": "GeForce+RTX+4090&id=4606",
  "RTX 4080S": "GeForce+RTX+4080+SUPER&id=4984",
  "RTX 4080": "GeForce+RTX+4080&id=4622",
  "RTX 3090 Ti": "GeForce+RTX+3090+Ti&id=4524",
  "RTX 3090": "GeForce+RTX+3090&id=4284",
  "RTX 3080 Ti": "GeForce+RTX+3080+Ti&id=4409",
  "RTX 3080": "GeForce+RTX+3080&id=4282",
  "RTX A6000": "RTX+A6000&id=4337",
  "RTX 6000Ada": "RTX+6000+Ada+Generation&id=4768",
  L40S: "L40S&id=5017",
  L40: "nVidia+L40&id=4885",
  A40: "A40&id=7083",
  "Tesla T4": "Tesla+T4&id=4211",
};

/** PassMark's page for the GPU; null when its name is not listed. */
export function gpuLink(gpuName: string | undefined): string | null {
  const page = gpuName === undefined ? undefined : PAGES[gpuName];
  return page === undefined ? null : SITE + page;
}

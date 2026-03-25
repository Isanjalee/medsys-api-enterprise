export type TerminologySuggestion = {
  code: string;
  codeSystem: string;
  display: string;
};

export type RecommendedTest = TerminologySuggestion & {
  category: "laboratory" | "observation" | "screening";
};

const CURATED_RECOMMENDED_TESTS: Array<{
  match: { exact?: string; prefix?: string };
  tests: RecommendedTest[];
}> = [
  {
    match: { prefix: "E11" },
    tests: [
      {
        code: "4548-4",
        codeSystem: "LOINC",
        display: "Hemoglobin A1c/Hemoglobin.total in Blood",
        category: "laboratory"
      },
      {
        code: "1558-6",
        codeSystem: "LOINC",
        display: "Fasting glucose [Mass/volume] in Serum or Plasma",
        category: "laboratory"
      },
      {
        code: "14959-1",
        codeSystem: "LOINC",
        display: "Microalbumin/Creatinine [Mass Ratio] in Urine",
        category: "laboratory"
      }
    ]
  },
  {
    match: { prefix: "I10" },
    tests: [
      {
        code: "85354-9",
        codeSystem: "LOINC",
        display: "Blood pressure panel with all children optional",
        category: "observation"
      },
      {
        code: "62238-1",
        codeSystem: "LOINC",
        display: "Renal function panel",
        category: "laboratory"
      }
    ]
  },
  {
    match: { prefix: "J45" },
    tests: [
      {
        code: "20150-9",
        codeSystem: "LOINC",
        display: "FEV1/FVC",
        category: "observation"
      },
      {
        code: "19868-9",
        codeSystem: "LOINC",
        display: "Peak expiratory flow rate",
        category: "observation"
      }
    ]
  },
  {
    match: { exact: "J06.9" },
    tests: [
      {
        code: "57021-8",
        codeSystem: "LOINC",
        display: "CBC W Auto Differential panel - Blood",
        category: "laboratory"
      }
    ]
  },
  {
    match: { exact: "B34.9" },
    tests: [
      {
        code: "57021-8",
        codeSystem: "LOINC",
        display: "CBC W Auto Differential panel - Blood",
        category: "laboratory"
      },
      {
        code: "1988-5",
        codeSystem: "LOINC",
        display: "C reactive protein [Mass/volume] in Serum or Plasma",
        category: "laboratory"
      }
    ]
  }
];

export const getRecommendedTestsForDiagnosis = (code: string): RecommendedTest[] => {
  const normalizedCode = code.trim().toUpperCase();
  for (const entry of CURATED_RECOMMENDED_TESTS) {
    if (entry.match.exact && entry.match.exact.toUpperCase() === normalizedCode) {
      return entry.tests;
    }
    if (entry.match.prefix && normalizedCode.startsWith(entry.match.prefix.toUpperCase())) {
      return entry.tests;
    }
  }
  return [];
};

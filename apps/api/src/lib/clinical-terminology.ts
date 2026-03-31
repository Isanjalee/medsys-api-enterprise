export type TerminologySuggestion = {
  code: string;
  codeSystem: string;
  display: string;
};

const CURATED_ICD10_DIAGNOSES: TerminologySuggestion[] = [
  { code: "R14.1", codeSystem: "ICD-10-CM", display: "Gas pain" },
  { code: "R14.3", codeSystem: "ICD-10-CM", display: "Flatulence" },
  { code: "K29.70", codeSystem: "ICD-10-CM", display: "Gastritis, unspecified, without bleeding" },
  { code: "K21.9", codeSystem: "ICD-10-CM", display: "Gastro-esophageal reflux disease without esophagitis" },
  { code: "K52.9", codeSystem: "ICD-10-CM", display: "Noninfective gastroenteritis and colitis, unspecified" },
  { code: "R10.13", codeSystem: "ICD-10-CM", display: "Epigastric pain" },
  { code: "R10.9", codeSystem: "ICD-10-CM", display: "Unspecified abdominal pain" },
  { code: "R11.0", codeSystem: "ICD-10-CM", display: "Nausea" },
  { code: "R19.7", codeSystem: "ICD-10-CM", display: "Diarrhea, unspecified" },
  { code: "K59.00", codeSystem: "ICD-10-CM", display: "Constipation, unspecified" },
  { code: "J06.9", codeSystem: "ICD-10-CM", display: "Acute upper respiratory infection, unspecified" },
  { code: "J18.9", codeSystem: "ICD-10-CM", display: "Pneumonia, unspecified organism" },
  { code: "J45.909", codeSystem: "ICD-10-CM", display: "Unspecified asthma, uncomplicated" },
  { code: "I10", codeSystem: "ICD-10-CM", display: "Essential (primary) hypertension" },
  { code: "E11.9", codeSystem: "ICD-10-CM", display: "Type 2 diabetes mellitus without complications" }
];

export type RecommendedTest = TerminologySuggestion & {
  category: "laboratory" | "observation" | "screening";
};

export type FallbackTestSuggestion = TerminologySuggestion & {
  category: string | null;
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

export const searchFallbackTests = (terms: string, limit: number): FallbackTestSuggestion[] => {
  const normalizedTerms = terms.trim().toLowerCase();
  if (!normalizedTerms) {
    return [];
  }

  const seen = new Set<string>();

  return CURATED_RECOMMENDED_TESTS
    .flatMap((entry) => entry.tests)
    .filter((item) => {
      const key = `${item.code}|${item.display}`.toLowerCase();
      if (seen.has(key)) {
        return false;
      }

      const haystack = `${item.code} ${item.display} ${item.category ?? ""}`.toLowerCase();
      const isMatch = haystack.includes(normalizedTerms);
      if (isMatch) {
        seen.add(key);
      }
      return isMatch;
    })
    .slice(0, limit);
};

export const searchFallbackDiagnoses = (terms: string, limit: number): TerminologySuggestion[] => {
  const normalizedTerms = terms.trim().toLowerCase();
  if (!normalizedTerms) {
    return [];
  }

  return CURATED_ICD10_DIAGNOSES
    .filter((item) => {
      const haystack = `${item.code} ${item.display}`.toLowerCase();
      return haystack.includes(normalizedTerms);
    })
    .slice(0, limit);
};

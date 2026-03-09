export const buildDisplayName = (firstName: string, lastName: string): string =>
  [firstName, lastName].map((part) => part.trim()).filter(Boolean).join(" ");

export const splitFullName = (
  name: string
): { firstName: string; lastName: string; fullName: string } => {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const firstName = parts.shift() ?? "";
  const lastName = parts.join(" ");
  return {
    firstName,
    lastName,
    fullName: buildDisplayName(firstName, lastName)
  };
};

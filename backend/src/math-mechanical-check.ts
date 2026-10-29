export type RationalValue = { numerator: string; denominator: string };
export type RationalExpression =
  | { value: RationalValue }
  | {
      op: "add" | "subtract" | "multiply" | "divide";
      left: RationalExpression;
      right: RationalExpression;
    };
export interface ArithmeticCheck {
  kind: "rational";
  expression: RationalExpression;
  expected: RationalValue;
}
// Deliberately limited arithmetic data: no code, functions, expressions to eval,
// floating-point rounding, or claims that sampled values prove general identities.
export function verifyArithmeticCheck(raw: unknown): ArithmeticCheck {
  const fail = (): never => {
    throw Object.assign(new Error("INVALID_OUTPUT"), {
      repairCode: "mechanical_check",
      repair:
        "Correct the typed rational arithmetic and expected result. Do not use executable code or zero denominators.",
    });
  };
  let nodes = 0;
  const reduced = (n: bigint, d: bigint): [bigint, bigint] => {
    if (d === 0n || n.toString().length > 4000 || d.toString().length > 4000)
      return fail();
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    let a = n < 0n ? -n : n,
      b = d;
    while (b) {
      const r = a % b;
      a = b;
      b = r;
    }
    return [n / a, d / a];
  };
  const value = (v: RationalValue): [bigint, bigint] => {
    if (
      !v ||
      typeof v.numerator !== "string" ||
      typeof v.denominator !== "string" ||
      !/^-?\d{1,64}$/.test(v.numerator) ||
      !/^-?\d{1,64}$/.test(v.denominator)
    )
      return fail();
    return reduced(BigInt(v.numerator), BigInt(v.denominator));
  };
  const evaluate = (e: RationalExpression, depth = 0): [bigint, bigint] => {
    if (!e || typeof e !== "object" || depth > 16 || ++nodes > 100)
      return fail();
    if ("value" in e) return value(e.value);
    const [a, b] = evaluate(e.left, depth + 1),
      [c, d] = evaluate(e.right, depth + 1);
    switch (e.op) {
      case "add":
        return reduced(a * d + c * b, b * d);
      case "subtract":
        return reduced(a * d - c * b, b * d);
      case "multiply":
        return reduced(a * c, b * d);
      case "divide":
        return reduced(a * d, b * c);
      default:
        return fail();
    }
  };
  const check = raw as ArithmeticCheck;
  if (!check || check.kind !== "rational") return fail();
  const [a, b] = evaluate(check.expression),
    [c, d] = value(check.expected);
  if (a !== c || b !== d) return fail();
  return check;
}

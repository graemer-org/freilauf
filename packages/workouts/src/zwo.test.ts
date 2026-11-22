import { describe, expect, it } from 'vitest';
import type { Workout } from './model';
import { buildTimeline } from './timeline';
import { BUILTIN_WORKOUTS } from './library';
import { MAX_ZWO_BYTES, parseZwo, utf8ByteLength, workoutToZwo } from './zwo';

const REALISTIC = `﻿<?xml version="1.0" encoding="UTF-8"?>
<!-- Exported by some tool -->
<workout_file>
    <author>Jane &amp; Joe</author>
    <name>Tempo &lt;Pyramid&gt;</name>
    <description><![CDATA[A pyramid with <tempo> blocks & "fun".]]>
Second line &#8212; with an em dash &#x1F6B4;</description>
    <sportType>bike</sportType>
    <tags>
        <tag name="Tempo"/>
        <tag name="INTERMEDIATE"/>
    </tags>
    <workout>
        <Warmup Duration="600" PowerLow="0.40" PowerHigh="0.75" Cadence="90">
            <textevent timeoffset="0" message="Welcome! Easy spin to start."/>
            <textevent timeoffset="300" message="Halfway through the warm-up"/>
        </Warmup>
        <SteadyState Duration="300" Power="0.80"/>
        <IntervalsT Repeat="4" OnDuration="60" OffDuration="120" OnPower="1.10" OffPower="0.55" Cadence="100" CadenceResting="85">
            <textevent timeoffset="0" message="First on &apos;effort&apos;"/>
            <textevent timeoffset="190" message="Second rep"/>
        </IntervalsT>
        <Ramp Duration="120" PowerLow="0.6" PowerHigh="0.9"/>
        <FreeRide Duration="300" FlatRoad="1"/>
        <FreeRide Duration="60"/>
        <Cooldown Duration="480" PowerLow="0.70" PowerHigh="0.35"/>
    </workout>
</workout_file>
`;

const wrap = (blocks: string, meta = '<name>T</name>') =>
  `<workout_file>${meta}<workout>${blocks}</workout></workout_file>`;

describe('parseZwo', () => {
  it('parses a realistic multi-block workout', () => {
    const r = parseZwo(REALISTIC);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings).toEqual([]);
    const w = r.workout;
    expect(w.name).toBe('Tempo <Pyramid>');
    expect(w.author).toBe('Jane & Joe');
    expect(w.description).toBe(
      'A pyramid with <tempo> blocks & "fun".\nSecond line — with an em dash 🚴',
    );
    expect(w.tags).toEqual(['tempo', 'intermediate']);
    expect(w.id).toMatch(/^zwo-tempo-pyramid-[0-9a-z]+$/);
    expect(w.steps).toEqual([
      {
        kind: 'ramp',
        durationS: 600,
        powerStart: 0.4,
        powerEnd: 0.75,
        cadenceRpm: 90,
        cues: [
          { atS: 0, message: 'Welcome! Easy spin to start.' },
          { atS: 300, message: 'Halfway through the warm-up' },
        ],
      },
      { kind: 'steady', durationS: 300, power: 0.8 },
      {
        kind: 'intervals',
        repeat: 4,
        onDurationS: 60,
        onPower: 1.1,
        offDurationS: 120,
        offPower: 0.55,
        onCadenceRpm: 100,
        offCadenceRpm: 85,
        cues: [
          { atS: 0, message: "First on 'effort'" },
          { atS: 190, message: 'Second rep' },
        ],
      },
      { kind: 'ramp', durationS: 120, powerStart: 0.6, powerEnd: 0.9 },
      { kind: 'freeRide', durationS: 300, gradePercent: 0 },
      { kind: 'freeRide', durationS: 60 },
      { kind: 'ramp', durationS: 480, powerStart: 0.7, powerEnd: 0.35 },
    ]);
    const tl = buildTimeline(w);
    expect(tl.totalDurationS).toBe(600 + 300 + 720 + 120 + 300 + 60 + 480);
    expect(tl.cues.find((c) => c.message === 'Second rep')?.atS).toBe(900 + 190);
  });

  it('is deterministic (same id for the same file)', () => {
    const a = parseZwo(REALISTIC);
    const b = parseZwo(REALISTIC);
    expect(a.ok && b.ok && a.workout.id === b.workout.id).toBe(true);
  });

  it('tolerates unknown elements and attributes with warnings', () => {
    const r = parseZwo(
      wrap(
        `<SteadyState Duration="60" Power="0.7" pace="0" Quantize="1"/>
         <MaxEffort Duration="20"/>
         <SteadyState Duration="60" Power="0.7"><textevent timeoffset="5" message="x" y="240"/><foo/></SteadyState>`,
        '<name>T</name><category>x</category><subcategory/>',
      ),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.workout.steps).toHaveLength(2);
    expect(r.warnings).toEqual(
      expect.arrayContaining([
        'Ignored attribute pace on <SteadyState>',
        'Ignored attribute Quantize on <SteadyState>',
        'Ignored unsupported element <MaxEffort>',
        'Ignored element <category>',
        'Ignored element <subcategory>',
        'Ignored attribute y on <textevent>',
        'Ignored element <foo> inside <SteadyState>',
      ]),
    );
  });

  it('normalises ascending cool-downs and SteadyState without Power', () => {
    const r = parseZwo(
      wrap(
        '<SteadyState Duration="60" PowerLow="0.6" PowerHigh="0.8"/><Cooldown Duration="300" PowerLow="0.3" PowerHigh="0.6"/>',
      ),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.workout.steps[0]).toMatchObject({ kind: 'steady', power: 0.7 });
    expect(r.workout.steps[1]).toMatchObject({ powerStart: 0.6, powerEnd: 0.3 });
    expect(r.warnings).toHaveLength(2);
  });

  it('rounds fractional durations, drops zero cadence and out-of-range text events', () => {
    const r = parseZwo(
      wrap(
        '<SteadyState Duration="59.6" Power="0.7" Cadence="0"><textevent timeoffset="90" message="late"/></SteadyState>',
      ),
    );
    expect(r.ok && r.workout.steps[0]).toEqual({ kind: 'steady', durationS: 60, power: 0.7 });
    expect(r.warnings[0]).toContain('outside the block');
  });

  it('defaults the name and accepts single-quoted attributes and processing instructions', () => {
    const r = parseZwo(
      "<?xml version='1.0'?><?app foo?><workout_file><workout><SteadyState Duration='60' Power='0.5' /></workout></workout_file>",
    );
    expect(r.ok && r.workout.name).toBe('Imported workout');
  });

  it('sanitises control characters in text via validation', () => {
    const r = parseZwo(
      wrap('<SteadyState Duration="60" Power="0.5"/>', '<name>A\u0001B‮ C</name>'),
    );
    expect(r.ok && r.workout.name).toBe('AB C');
  });

  const rejects: [string, string, RegExp][] = [
    ['empty input', '', /no root/],
    ['not XML', 'hello world', /outside the root/],
    ['DOCTYPE', '<!DOCTYPE workout_file><workout_file/>', /DOCTYPE/],
    [
      'entity declaration (billion laughs)',
      '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]><workout_file>&lol2;</workout_file>',
      /DOCTYPE/,
    ],
    [
      'external entity reference',
      wrap('<SteadyState Duration="60" Power="0.5"/>', '<name>&xxe;</name>'),
      /entity/,
    ],
    ['unknown named entity', wrap('', '<name>&nbsp;</name>'), /entity/],
    ['invalid char ref', wrap('', '<name>&#0;</name>'), /character reference/],
    ['bare ampersand', wrap('', '<name>a & b</name>'), /entity/],
    ['mismatched tags', '<workout_file><workout></workout_file>', /mismatched/],
    ['unclosed root', '<workout_file><workout/>', /unclosed/],
    ['two roots', '<workout_file/><workout_file/>', /more than one root/],
    [
      'duplicate attribute',
      wrap('<SteadyState Duration="1" Duration="2" Power="1"/>'),
      /duplicate attribute/,
    ],
    ['unquoted attribute', wrap('<SteadyState Duration=60 Power="1"/>'), /quoted/],
    ['unterminated comment', '<workout_file><!-- x </workout_file>', /comment/],
    ['unterminated CDATA', '<workout_file><![CDATA[x</workout_file>', /CDATA/],
    ['late XML declaration', '<workout_file/><?xml version="1.0"?>', /declaration/],
    ['wrong root', '<workout><SteadyState Duration="1" Power="1"/></workout>', /Root element/],
    ['missing workout', '<workout_file><name>x</name></workout_file>', /Missing <workout>/],
    ['no blocks', wrap(''), /no supported blocks/],
    ['missing Duration', wrap('<SteadyState Power="0.5"/>'), /missing attribute Duration/],
    ['non-numeric Power', wrap('<SteadyState Duration="60" Power="high"/>'), /not a number/],
    ['hex-ish number', wrap('<SteadyState Duration="0x10" Power="0.5"/>'), /not a number/],
    ['power above cap', wrap('<SteadyState Duration="60" Power="4"/>'), /power/],
    ['zero duration', wrap('<SteadyState Duration="0.2" Power="0.5"/>'), /durationS/],
    [
      'running workout',
      wrap('<SteadyState Duration="60" Power="0.5"/>', '<sportType>run</sportType>'),
      /Running/,
    ],
    [
      'distance workout',
      wrap('<SteadyState Duration="60" Power="0.5"/>', '<durationType>distance</durationType>'),
      /Distance/,
    ],
    [
      'too deep',
      '<workout_file>' + '<a>'.repeat(40) + '</a>'.repeat(40) + '</workout_file>',
      /too deep/,
    ],
  ];
  it.each(rejects)('rejects %s', (_, xml, pattern) => {
    const r = parseZwo(xml);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toMatch(pattern);
  });

  it('rejects input larger than 1 MiB (by UTF-8 bytes)', () => {
    const pad = `<!-- ${'x'.repeat(MAX_ZWO_BYTES)} -->`;
    const r = parseZwo(wrap('<SteadyState Duration="60" Power="0.5"/>') + pad);
    expect(!r.ok && r.errors[0]).toMatch(/larger than/);
    const multibyte = `<!-- ${'é'.repeat(MAX_ZWO_BYTES / 2)} -->`; // under 1 Mi chars, over 1 MiB bytes
    const r2 = parseZwo(wrap('<SteadyState Duration="60" Power="0.5"/>') + multibyte);
    expect(r2.ok).toBe(false);
  });

  it('rejects non-string input without throwing', () => {
    expect(parseZwo(undefined as unknown as string).ok).toBe(false);
    expect(parseZwo({} as unknown as string).ok).toBe(false);
  });

  it('counts UTF-8 bytes', () => {
    expect(utf8ByteLength('aé€🚴')).toBe(1 + 2 + 3 + 4);
  });
});

describe('workoutToZwo', () => {
  it('round-trips through parseZwo', () => {
    const w: Workout = {
      id: 'rt',
      name: 'Round <trip> & "quotes"',
      description: 'Line 1\nLine 2',
      author: "O'Brien",
      tags: ['a', 'b'],
      steps: [
        { kind: 'ramp', durationS: 600, powerStart: 0.4, powerEnd: 0.75, cadenceRpm: 90 },
        {
          kind: 'steady',
          durationS: 300,
          power: 0.8125,
          cues: [{ atS: 10, message: 'Hi & <bye>' }],
        },
        {
          kind: 'intervals',
          repeat: 5,
          onDurationS: 30,
          onPower: 1.2,
          offDurationS: 30,
          offPower: 0.5,
          onCadenceRpm: 100,
          offCadenceRpm: 80,
        },
        { kind: 'ramp', durationS: 60, powerStart: 0.9, powerEnd: 0.6 },
        { kind: 'freeRide', durationS: 120, gradePercent: 0 },
        { kind: 'freeRide', durationS: 120 },
        { kind: 'ramp', durationS: 300, powerStart: 0.6, powerEnd: 0.4 },
      ],
    };
    const xml = workoutToZwo(w);
    expect(xml).toContain('<Warmup Duration="600"');
    expect(xml).toContain('<Cooldown Duration="300" PowerLow="0.6" PowerHigh="0.4"/>');
    expect(xml).toContain('<Ramp Duration="60" PowerLow="0.9" PowerHigh="0.6"/>');
    const r = parseZwo(xml);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings).toEqual([]);
    const { id: _a, ...expected } = w;
    const { id: _b, ...actual } = r.workout;
    expect(actual).toEqual(expected);
  });

  it('exports every built-in workout losslessly apart from labels and hints', () => {
    for (const w of BUILTIN_WORKOUTS) {
      const r = parseZwo(workoutToZwo(w));
      expect(r.ok, w.id).toBe(true);
      if (!r.ok) continue;
      const strip = (x: Workout) =>
        x.steps.map((s) => {
          const { label: _l, ...rest } = s as typeof s & { label?: string; expectedPower?: number };
          if (rest.kind === 'freeRide') {
            delete (rest as { expectedPower?: number }).expectedPower;
            if (rest.gradePercent !== 0) delete rest.gradePercent; // only flat road survives
          }
          return rest;
        });
      expect(strip(r.workout)).toEqual(strip(w));
      expect(buildTimeline(r.workout).totalDurationS).toBe(buildTimeline(w).totalDurationS);
    }
  });
});

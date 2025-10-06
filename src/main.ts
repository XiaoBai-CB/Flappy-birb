/**
 * Inside this file you will use the classes and functions from rx.js
 * to add visuals to the svg element in index.html, animate them, and make them interactive.
 *
 * Study and complete the tasks in observable exercises first to get ideas.
 *
 * Course Notes showing Asteroids in FRP: https://tgdwyer.github.io/asteroids/
 *
 * You will be marked on your functional programming style
 * as well as the functionality that you implement.
 *
 * Document your code!
 */

import "./style.css";

import {
    Observable,
    catchError,
    filter,
    fromEvent,
    interval,
    map,
    merge,
    scan,
    startWith,
    switchMap,
    take,
} from "rxjs";
import { fromFetch } from "rxjs/fetch";

/** Constants */

const Viewport = {
    CANVAS_WIDTH:  600,
    CANVAS_HEIGHT: 400,
} as const;

const Birb = {
    WIDTH:  42,
    HEIGHT: 30,
} as const;

const Constants = {
    PIPE_WIDTH:   50,
    TICK_RATE_MS: 20, // Might need to change this!
} as const;

const GRAVITY       = 0.5;
const FLAP_VELOCITY = -6;
const INITIAL_LIVES = 3;
const SCROLL_SPEED  = 3;

// User input

type Key = "Space";

// State processing

type Bird = Readonly<{
    x: number;
    y: number;
    velocityY: number;
}>;

type Pipe = Readonly<{
    id: number;
    gapY: number;   // Gap center y
    gapH: number;   // Clearance height
    time: number;   // Appearance time (seconds)
    x: number;  // Current x(px, entered from the right)
    passed: boolean;
}>

type PipeTemplate = Readonly<{
    id: number;
    gapY: number;   // px center
    gapH: number;   // px height
    time: number;   // seconds
}>

type State = Readonly<{
    bird: Bird;
    pipes: ReadonlyArray<Pipe>;
    pending: ReadonlyArray<PipeTemplate>;
    lives: number;
    score: number;
    gameEnd: boolean;
    elapsedMs: number;
}>;

// initialization
const initialState: State = {
    bird: { 
        x: Viewport.CANVAS_WIDTH * 0.3 - Birb.WIDTH / 2, 
        y: Viewport.CANVAS_HEIGHT / 2 - Birb.HEIGHT / 2, 
        velocityY: 0
    },
    pipes: [],
    pending: [],
    lives: INITIAL_LIVES,
    score: 0,
    gameEnd: false,
    elapsedMs: 0,
};

type BirdPath = Readonly<{ elapsedMs: number; x: number; y: number }>;

// Define a type for a completed run, including its path, final score and player id(add for rank)
type GhostRun = Readonly<{
    path: ReadonlyArray<BirdPath>;
    score: number;
    playerId: number;
}>;

// Update ghostRuns to store an array of GhostRun objects
const ghostRuns: GhostRun[] = []; // session history

type StateWithRun = {
  state: State;
  run: BirdPath[];
};

// Utility: partition array by predicate into [yes, no] which is easy to know when is the pipe need to make it
const partition = <T,>(arr: ReadonlyArray<T>, pred: (x: T) => boolean): [ReadonlyArray<T>, ReadonlyArray<T>] => {
    const yes: T[] = [], no: T[] = [];
    arr.forEach(x => (pred(x) ? yes : no).push(x));
    return [yes, no];
};

// Parse CSV into pipe templates (values in CSV are normalized 0..1 for y/height)
const parsePipes = (csvContents: string): ReadonlyArray<PipeTemplate> => {
    const lines = csvContents.trim().split(/\r?\n/);
    const headerless = lines.slice(1);
    return headerless.map((line, idx) => {
        const [gapYNorm, gapHNorm, timeStr] = line.split(",");
        const gapY = parseFloat(gapYNorm) * Viewport.CANVAS_HEIGHT;
        const gapH = parseFloat(gapHNorm) * Viewport.CANVAS_HEIGHT;
        const time = parseFloat(timeStr);
        return { id: idx, gapY, gapH, time } as PipeTemplate;
    });
};

/**
 * Updates the state by proceeding with one time step.
 * Make ticks really update physics (gravity + pipe displacement).
 *
 * @param s Current state
 * @returns Updated state
 */
const tick = (s: State): State => {
    if (s.gameEnd) return s;    // Not update if gameover

    // Physics gravity simulation
    const newBird = {
        ...s.bird,
        y: s.bird.y + s.bird.velocityY,
        velocityY: s.bird.velocityY + GRAVITY,
    };
    
    // Move existing pipes left
    const movedPipes = s.pipes.map(p => ({...p, x: p.x - SCROLL_SPEED}))

    // Spawn new pipes whose time has come
    const nextElapsedMs = s.elapsedMs + Constants.TICK_RATE_MS;
    const [toSpawn, stillPending] = partition(
        s.pending,
        tpl => !(tpl.time * 1000 >= nextElapsedMs)
    );

    // Generate a new pipeline object
    const spawned: ReadonlyArray<Pipe> = toSpawn.map(tpl => ({
        id: tpl.id,
        gapY: tpl.gapY,
        gapH: tpl.gapH,
        time: tpl.time,
        x: Viewport.CANVAS_WIDTH,   // Right move in
        passed: false,  // Bird not pass it
    }));

    const allPipes = [...movedPipes, ...spawned];

    // Check for collisions and update lives
    const collisionResult = checkCollisions(newBird, allPipes);
    const updatedBird = collisionResult.bird;
    const updatedLives = s.lives + collisionResult.lifeChange;

    // Update score when passing pipes
    const scoreToAdd = allPipes.filter(p => !p.passed && p.x + Constants.PIPE_WIDTH < updatedBird.x).length;
    const updatedScore = s.score + scoreToAdd;

    // First, calculate the newly added score
    const updatedPipes = allPipes
        .map(p => ({
            ...p,
            passed: p.passed || (p.x + Constants.PIPE_WIDTH < updatedBird.x)
        }))
        .filter(p => p.x + Constants.PIPE_WIDTH > 0);

    // Check game over condition
    const gameEnd = updatedLives <= 0 || (stillPending.length === 0 && updatedPipes.length === 0);

    return {
        ...s,   // other not chenge
        bird: updatedBird,
        pipes: updatedPipes,
        pending: stillPending,
        elapsedMs: nextElapsedMs,
        lives: updatedLives,
        score: updatedScore,
        gameEnd: gameEnd,
    }
};

/**
 * Checks for collisions between bird and pipes/screen boundaries
 * Returns updated bird state and life change
 */
const checkCollisions = (bird: Bird, pipes: ReadonlyArray<Pipe>): { bird: Bird, lifeChange: number } => {
    // Check screen boundary collisions first
    if (bird.y <= 0) {
        
        // Hit top of screen, and bounce down with random velocity
        return {
            bird: { ...bird, y: 0, velocityY: Math.random() * 3 + 2 },
            lifeChange: -1,
        };
    }
    if (bird.y + Birb.HEIGHT >= Viewport.CANVAS_HEIGHT) {

        // Hit bottom of screen, and bounce up with random velocity
        return {
            bird: { ...bird, y: Viewport.CANVAS_HEIGHT - Birb.HEIGHT, velocityY: -(Math.random() * 3 + 2) },
            lifeChange: -1,
        };
    }

    // Check pipe collisions using find
    const collidedPipe = pipes.find(pipe => 
        bird.x + Birb.WIDTH > pipe.x && 
        bird.x < pipe.x + Constants.PIPE_WIDTH && 
        (bird.y < (pipe.gapY - pipe.gapH / 2) || bird.y + Birb.HEIGHT > (pipe.gapY + pipe.gapH / 2))
    );

    if (collidedPipe) {
        const birdTop = bird.y;
        const gapTop = collidedPipe.gapY - collidedPipe.gapH / 2;

        if (birdTop < gapTop) {
            // Hit top pipe - bounce down
            return {
                bird: { ...bird, velocityY: Math.random() * 3 + 2 },
                lifeChange: -1,
            };
        } else {
            // Hit bottom pipe - bounce up
            return {
                bird: { ...bird, velocityY: -(Math.random() * 3 + 2) },
                lifeChange: -1,
            };
        }
    }

    // No collision
    return { bird: bird, lifeChange: 0 };
};


// Rendering (side effects)

/**
 * Brings an SVG element to the foreground.
 * @param elem SVG element to bring to the foreground
 */
const bringToForeground = (elem: SVGElement): void => {
    elem.parentNode?.appendChild(elem);
};

/**
 * Displays a SVG element on the canvas. Brings to foreground.
 * @param elem SVG element to display
 */
const show = (elem: SVGElement): void => {
    elem.setAttribute("visibility", "visible");
    bringToForeground(elem);
};

/**
 * Hides a SVG element on the canvas.
 * @param elem SVG element to hide
 */
const hide = (elem: SVGElement): void => {
    elem.setAttribute("visibility", "hidden");
};

/**
 * Creates an SVG element with the given properties.
 *
 * See https://developer.mozilla.org/en-US/docs/Web/SVG/Element for valid
 * element names and properties.
 *
 * @param namespace Namespace of the SVG element
 * @param name SVGElement name
 * @param props Properties to set on the SVG element
 * @returns SVG element
 */
const createSvgElement = (
    namespace: string | null,
    name: string,
    props: Record<string, string> = {},
): SVGElement => {
    const elem = document.createElementNS(namespace, name) as SVGElement;
    Object.entries(props).forEach(([k, v]) => elem.setAttribute(k, v));
    return elem;
};

const render = (): ((s: State) => void) => {
    // Canvas elements
    const gameOver = document.querySelector("#gameOver") as SVGElement;
    const container = document.querySelector("#main") as HTMLElement;

    // Text fields
    const livesText = document.querySelector("#livesText") as HTMLElement;
    const scoreText = document.querySelector("#scoreText") as HTMLElement;

    const svg = document.querySelector("#svgCanvas") as SVGSVGElement;

    // Rank list of new element
    const rankList = document.querySelector("#rankList") as HTMLOListElement;

    const lastGhostRunsLengthRef = { value: -1 };

    // Updates the rank display if one round completed runs
    const updateLeaderboard = () => {
        // Update the DOM if a new run is added
        if (ghostRuns.length === lastGhostRunsLengthRef.value) return;

        lastGhostRunsLengthRef.value = ghostRuns.length;
        rankList.innerHTML = ""; // Clear previous line

        // Descending sort
        const sortedRuns = [...ghostRuns].sort((a, b) => b.score - a.score);
        const top5Runs = sortedRuns.slice(0, 5);    // Show top 5 players

        // Create and append list items for the top 5 scores
        top5Runs.forEach((run) => {
            const listLine = document.createElement("li");
            // Display Player id and Score
            listLine.textContent = ` #Player${run.playerId} Score:${run.score}`;
            rankList.appendChild(listLine);
        });
    };

    // Add helper to get ghost Y position at given elapsedMs
    const interpolateGhost = (path: ReadonlyArray<BirdPath>, elapsedMs: number): BirdPath | null => {
        const idx = path.findIndex(p => p.elapsedMs >= elapsedMs);
        if (idx <= 0) {
            // It is in the start of path or path is empty.
            // Return null so no ghost is drawn.
            return null;
        }
        // Makes the ghost stay at its final position and return
        return path[idx];
    };

    svg.setAttribute(
        "viewBox",
        `0 0 ${Viewport.CANVAS_WIDTH} ${Viewport.CANVAS_HEIGHT}`,
    );

    /**
     * Renders the current state to the canvas.
     *
     * In MVC terms, this updates the View using the Model.
     *
     * @param s Current state
     */
    return (s: State) => {
        updateLeaderboard();    // Check and update the Rank for each frame

        // Clear frame
        const toRemove = Array.from(svg.children).filter(c => c.id !== "gameOver");
        toRemove.forEach(c => svg.removeChild(c));
        
        // Draw ghosts first, and they are behind the player bird
        ghostRuns.forEach((run) => {
            const ghost = interpolateGhost(run.path, s.elapsedMs);
            if (ghost) {
                const ghostImg = createSvgElement(svg.namespaceURI, "image", {
                    href: "assets/birb.png",
                    x: `${ghost.x}`,
                    y: `${ghost.y}`,
                    width: `${Birb.WIDTH}`,
                    height: `${Birb.HEIGHT}`,
                    opacity: "0.3" // distinguish ghost
                });
                svg.appendChild(ghostImg);
            }
        });

        // Add player birb to the main grid canvas
        const birdImg = createSvgElement(svg.namespaceURI, "image", {
            href: "assets/birb.png",
            x: `${s.bird.x}`,
            y: `${s.bird.y}`,
            width: `${Birb.WIDTH}`,
            height: `${Birb.HEIGHT}`,
        });
        svg.appendChild(birdImg);

        // Draw a static pipe as a demonstration
        // const pipeGapY = 200; // vertical center of the gap
        // const pipeGapHeight = 100;

        // Render pipes
        s.pipes.forEach(p => {
            // Top pipe
            const pipeTop = createSvgElement(svg.namespaceURI, "rect", {
                x: `${p.x}`,
                y: "0",
                width: `${Constants.PIPE_WIDTH}`,
                height: `${p.gapY - p.gapH / 2}`,
                fill: "lightgreen",
            });

            // Bottom pipe
            const pipeBottom = createSvgElement(svg.namespaceURI, "rect", {
                x: `${p.x}`,
                y: `${p.gapY + p.gapH / 2}`,
                width: `${Constants.PIPE_WIDTH}`,
                height: `${Viewport.CANVAS_HEIGHT - (p.gapY + p.gapH / 2)}`,
                fill: "lightgreen",
            });

            svg.appendChild(pipeTop);
            svg.appendChild(pipeBottom);
        });

        // Show/hide game over
        s.gameEnd ? show(gameOver) : hide(gameOver);

        // Show score and lives
        livesText.textContent = `${s.lives}`;
        scoreText.textContent = `${s.score}`;
    };
};

export const state$ = (csvContents: string): Observable<State> => {
  const key$ = fromEvent<KeyboardEvent>(document, "keypress");
  const fromKey = (keyCode: Key) =>
    key$.pipe(filter(({ code }) => code === keyCode));

  const flap$ = fromKey("Space").pipe(
    map(_ => (s: State) => ({
      ...s,
      bird: { ...s.bird, velocityY: FLAP_VELOCITY },
    }))
  );

  const tick$ = interval(Constants.TICK_RATE_MS).pipe(
    map(_ => (s: State) => tick(s))
  );

  const actions$ = merge(tick$, flap$);

  const seed: State = {
    ...initialState,
    pending: parsePipes(csvContents),
  };

  const seedWithRun: StateWithRun = { state: seed, run: [] };

  return actions$.pipe(
    scan((acc: StateWithRun, reducer: (s: State) => State) => {
      const ns = reducer(acc.state);

      // extend current run with this frame
      const newRun = [...acc.run, { elapsedMs: ns.elapsedMs, x: ns.bird.x, y: ns.bird.y }];

      // if the game come to 'gameEnd' state, commit the run and score
      if (ns.gameEnd && !acc.state.gameEnd) {
        const nextPlayerId = ghostRuns.length + 1;  // Add the new path(Give a unique player id)
        ghostRuns.push({ path: newRun, score: ns.score, playerId: nextPlayerId });  // Only push paths(Add the score and id for rank)
        return { state: ns, run: [] };  // reset run for the next game
      }

      return { state: ns, run: newRun };
    }, seedWithRun),
    map(acc => acc.state) // only output State to downstream
  );
};

// The following simply runs your main function on window load.  Make sure to leave it in place.
// You should not need to change this, beware if you are.
if (typeof window !== "undefined") {
    const { protocol, hostname, port } = new URL(import.meta.url);
    const baseUrl = `${protocol}//${hostname}${port ? `:${port}` : ""}`;
    const csvUrl = `${baseUrl}/assets/map.csv`;

    // Get the file from csv URL and reload
    const csv$ = fromFetch(csvUrl).pipe(
        switchMap(response => {
            if (response.ok) {
                return response.text();
            } else {
                throw new Error(`Fetch error: ${response.status}`);
            }
        }),
        catchError(err => {
            console.error("Error fetching the CSV file:", err);
            throw err;
        }),
    );

    // Observable: wait for first user click
    const click$ = fromEvent(document.body, "mousedown").pipe(take(1));

    // Restart observable: press "R"
    const restart$ = fromEvent<KeyboardEvent>(document, "keydown").pipe(
        filter(event => event.code === "KeyR"),
        // #gameOver must be visible
        filter(() => {
            const gameOverElem = document.querySelector("#gameOver") as SVGElement | null;
            return gameOverElem ? gameOverElem.getAttribute("visibility") === "visible" : false;
        }),
        startWith(null)          // Trigger once in the first time to avoid being unable to enter the game
    );

    // Main game
    csv$.pipe(
        switchMap(contents =>
            // On click, start the game
            click$.pipe(
                switchMap(() =>
                    // Every time restart$ emits, restart the game
                    restart$.pipe(switchMap(() => state$(contents)))
                )
            )
        )
    ).subscribe(render());
}
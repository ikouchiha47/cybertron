# Gesture Recognition Approaches for WristTurn

## Dynamic Time Warping (DTW)

### Core Problem
When recording a reference gesture (e.g., letter Z) once, and later having the user perform the same gesture with variations in speed (e.g., 20% slower) or with pauses, a simple Euclidean distance between the two time series will incorrectly indicate they're different gestures, even though they represent the same motion.

### DTW Solution
DTW solves this by allowing elastic alignment - it warps the time axis of one sequence to best match the other, then measures distance on the aligned version {[https://www.audiolabs-erlangen.de/resources/MIR/FMP/C3/C3S2_DTWbasic.html](https://www.audiolabs-erlangen.de/resources/MIR/FMP/C3/C3S2_DTWbasic.html)}.

### Example
**Reference:** [A, B, B, C, D, D, E]  
**Query:**     [A, B, C, C, D, E, E]

DTW finds the optimal warping path through the cost matrix:

```
         A  B  C  C  D  E  E
    A  [ 0  .  .  .  .  .  . ]
    B  [ .  0  .  .  .  .  . ]
    B  [ .  0  .  .  .  .  . ]
    C  [ .  .  0  0  .  .  . ]
    D  [ .  .  .  .  0  .  . ]
    D  [ .  .  .  .  0  .  . ]
    E  [ .  .  .  .  .  0  0 ]
```

Constraints:
- Path must go left-to-right and top-to-bottom (monotonicity + continuity)
- DTW distance is the minimum cost of any valid path
- Standard implementation uses O(N²) dynamic programming {[https://www.audiolabs-erlangen.de/resources/MIR/FMP/C3/C3S2_DTWbasic.html](https://www.audiolabs-erlangen.de/resources/MIR/FMP/C3/C3S2_DTWbasic.html)}

### For Gesture Matching
Each "cell" in the cost matrix represents the Euclidean distance between two ω(t) samples (3D vectors). The path warps time but preserves the shape of the gesture.

### Sakoe-Chiba Band
To improve efficiency and prevent degenerate alignments:
- Constrain warping to a window of width W around the diagonal
- Reduces complexity from O(N²) to O(N·W)
- Prevents matching the entire reference to a single query point

**Explanation**: In unconstrained DTW, degenerate alignments can occur where the warping path becomes overly permissive, leading to meaningless matches. For example, without constraints, DTW might align an entire reference gesture sequence to just a few samples in the query sequence (or vice versa), completely destroying the temporal structure of the gesture. This happens because the algorithm seeks to minimize distance without regard for realistic temporal dynamics.

The Sakoe-Chiba band addresses both issues:
1. **Prevents degenerate alignments** by restricting how far the warping path can deviate from the diagonal, ensuring that nearby points in time remain nearby after warping (preserving temporal order and preventing "jumps" in alignment)
2. **Improves computational efficiency** by reducing the number of cells that need to be computed in the cost matrix from N×M to approximately N×W (where W is the band width), changing complexity from quadratic to linear with respect to sequence length when W is fixed

This constraint reflects the realistic assumption that gesture timing variations are local and bounded - a gesture performed 20% slower shouldn't map the first half of the reference to the first 10% of the query, for instance.

## Other Approaches (Ranked by Relevance to Wrist Gestures)

### 1. Feature Vector + Distance (Simplest, Fastest)
Instead of matching time series directly, extract scalar features from each gesture:
- [peak_roll_rate, peak_pitch_rate, total_roll_integral,
  total_pitch_integral, duration_ms, dominant_axis, ...]

Then compare feature vectors using Euclidean or cosine distance.

**Pros:**
- Works well for discrete gestures (L, Z, circle) with distinct feature profiles
- One template = one feature vector (no time series storage)
- Very fast computation

**Cons:**
- Fails on similar gestures that only differ in timing or subtle shape

**References:**
- The Benbasat (2002) approach uses peak detection and integral calculations for gesture recognition, showing that tracking peaks and their integrals can effectively distinguish gestures from noise. The paper states: "Since the velocity of the arm is zero at the ends of the gesture, the integral of the acceleration across it must be zero as well (after subtracting any baseline change due to change in orientation). Therefore, recognition is accomplished simply by tracking across an area of activity, and recording the number of peaks and their integral." {[https://3dvar.com/Benbasat2002An.pdf](https://3dvar.com/Benbasat2002An.pdf)}
- Various IMU-based gesture recognition systems extract features like peak rates, integrals, and statistical properties from accelerometer and gyroscope data for classification {[https://www.mdpi.com/2076-3417/10/12/4213](https://www.mdpi.com/2076-3417/10/12/4213), [https://www.mdpi.com/2227-9709/5/2/28](https://www.mdpi.com/2227-9709/5/2/28)}

### 2. $1 / $N Recognizer
Specifically designed for stroke gestures (originally touch input):
- Resamples gesture path to N equally-spaced points
- Rotates to canonical angle
- Scales to unit square
- Compares with "golden ratio" distance search
- Very fast, works with 1 example per class

**For wrist gestures:** Use the gravity vector path (g(t) tip on S²) as the "stroke". The $1 recognizer treats it as a 2D path on the sphere surface, mapping almost directly to what SymbolCapture records.

**Pros:**
- Simple to implement
- Interpretable
- 1-shot learning

**Cons:**
- Rotation normalization is lossy - two gestures differing only in starting orientation appear identical

**References:**
- The $1 Unistroke Recognizer is described as a 2-D single-stroke recognizer designed for rapid prototyping of gesture-based user interfaces, requiring very few templates to perform well and being only about 100 lines of code {[http://depts.washington.edu/acelab/proj/dollar/index.html](http://depts.washington.edu/acelab/proj/dollar/index.html)}
- The $1 recognizer uses golden section search for optimal rotation and scaling to match gestures, making it efficient for 1-shot learning scenarios {[http://depts.washington.edu/acelab/proj/dollar/index.html](http://depts.washington.edu/acelab/proj/dollar/index.html)}
- Extensions like the $N recognizer handle multi-stroke gestures, while the $P recognizer works with point-cloud representations that ignore stroke order and direction {[http://depts.washington.edu/acelab/proj/dollar/index.html](http://depts.washington.edu/acelab/proj/dollar/index.html)}

### 3. Hidden Markov Models (HMM)
Model each gesture as a sequence of hidden states with transition probabilities. Each state emits an observation (quantized ω vector). Training finds the state machine maximizing likelihood of observed sequences. Classification = which HMM gives highest probability for the input.

**Pros:**
- Handles variable length, noise, and tempo variation naturally
- Was industry standard for gesture recognition in 2000s-2010s
- Works well with 10-50 training examples per class

**Cons:**
- Requires training data per gesture (not 1-shot)
- Harder to implement from scratch

**References:**
- HMMs were the industry standard for gesture recognition in the 2000s-2010s, particularly effective when having 10-50 training examples per class. The paper states: "HMM-based approaches were shown to be effective at increasing the recognition rate of inertial sensing-based gesture recognition." {[https://www.mdpi.com/2076-3417/10/12/4213](https://www.mdpi.com/2076-3417/10/12/4213)}
- HMMs naturally handle variable length, noise, and tempo variations in gesture data, making them suitable for real-world applications. The paper notes: "However, HMM classifiers are expensive on account of their computational complexity; moreover, they require more than one training sample to efficiently train the model and obtain better recognition rates." {[https://www.mdpi.com/2227-9709/5/2/28](https://www.mdpi.com/2227-9709/5/2/28)}

### 4. Shapelet-based Matching
A shapelet is a short subsequence that maximally discriminates between classes. Instead of matching the whole sequence, find the most characteristic window and match only that.

**For wrist gestures:** The moment of peak jerk + following 200ms is often the most discriminating window (the rest is deceleration that looks similar across gestures).

**Pros:**
- Robust to timing variation at gesture ends

**Cons:**
- Shapelet discovery requires training data

**References:**
- Shapelets are defined as discriminative subsequences that have been successfully applied to gesture recognition from accelerometer data. The paper states: "Time series shapelets are small, local patterns in a time series that are highly predictive of a class and are thus very useful features for building classifiers and for certain visualization and summarization tasks." {[https://www.cs.nmsu.edu/~hcao/readings/cs508/kdd2011_p1154-mueen.pdf](https://www.cs.nmsu.edu/~hcao/readings/cs508/kdd2011_p1154-mueen.pdf)}
- Logical-shapelets extend the basic shapelet concept to handle more expressive queries while maintaining efficiency, with applications in gesture recognition. The paper notes: "We have demonstrated the existence of logical concepts in time series datasets, and the utility of logical shapelets in domains as diverse as gesture recognition, robotics and user authentication." {[https://dl.acm.org/doi/10.1145/2020408.2020587](https://dl.acm.org/doi/10.1145/2020408.2020587)}
- Ultra-Fast Shapelets provide state-of-the-art performance for time series classification including gesture recognition, being 3-4 orders of magnitude faster than existing methods. The paper states: "We empirically showed that our method is 3-4 orders of magnitude faster than the fastest existing discovery methods, while providing a better prediction quality." {[https://arxiv.org/pdf/1503.05018](https://arxiv.org/pdf/1503.05018)}
- Shapelet-based approaches have been used in gesture recognition with inertial sensors and optimized DTW prototypes. The paper notes: "Shapelets have been used in many applications such as medicine [4], gesture [10] and gait recognition [11] and even time series clustering [3]." {[https://arxiv.org/pdf/1503.03238](https://arxiv.org/pdf/1503.03238)}

### 5. Convolutional Neural Net on Raw Signal
Treat ω(t) as a multi-channel 1D signal (3 channels: gx, gy, gz). 1D conv layers extract local patterns (like learned shapelets).

**Pros:**
- Works extremely well with enough training data (hundreds of examples per class)

**Cons:**
- Overkill for use case requiring only 1-3 training examples per gesture

**References:**
- 1D CNNs on raw IMU signals have been shown to effectively extract local temporal patterns for gesture recognition, functioning similarly to learned shapelets but requiring substantial training data {[https://www.mdpi.com/2673-4591/120/1/75](https://www.mdpi.com/2673-4591/120/1/75)}
- For applications with limited training data (1-3 examples per gesture), simpler methods like DTW or feature-based approaches are more appropriate than deep learning approaches {[https://www.mdpi.com/2076-3417/10/12/4213](https://www.mdpi.com/2076-3417/10/12/4213)}